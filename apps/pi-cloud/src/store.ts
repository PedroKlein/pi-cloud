import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  emptyProfile,
  type ModelRef,
  type ProfileContent,
  type SessionOwner,
  type SessionStatus,
  type ThinkingLevel,
  type Workspace,
  type WorkspaceRemoval,
} from "@pi-cloud/protocol";
import type { PluginStore } from "@pi-cloud/plugins";
import type { ProfileStore, StoredProfile } from "@pi-cloud/profiles";
import {
  owner,
  type SessionStore,
  type StoredEnvironment,
  type StoredSession,
} from "@pi-cloud/sessions";

interface SessionRow {
  id: string;
  environment_id: string;
  owner_id: string;
  owner_plugin: string | null;
  owner_key: string | null;
  provider: string;
  runner: string | null;
  profile_id: string;
  workspace: string;
  model: string | null;
  system_prompt: string | null;
  first_message: string | null;
  thinking: ThinkingLevel | null;
  title: string | null;
  status: SessionStatus;
  generation: number;
  created_at: string;
  interrupted_at: string | null;
  error: string | null;
  archived_at: string | null;
  workspace_removal: WorkspaceRemoval | null;
  workspace_kept_reason: string | null;
}

interface ProfileRow {
  id: string;
  owner_id: string;
  name: string;
  content: string;
  created_at: string;
}

interface EnvironmentRow {
  id: string;
  name: string;
  provider: string;
  owner_id: string;
  created_at: string;
  setup_script: string;
  variables: string;
  secrets: string;
}

const environmentsTable = `
create table if not exists environments (
  id text primary key,
  name text not null,
  provider text not null unique,
  owner_id text not null,
  created_at text not null,
  setup_script text not null default '',
  variables text not null default '{}',
  secrets text not null default '{}'
);
`;

const profileTables = `
create table if not exists profiles (
  id text primary key,
  owner_id text not null,
  name text not null,
  content text not null,
  created_at text not null
);
create table if not exists repository_trust (
  owner_id text not null,
  repository text not null,
  trusted integer not null,
  primary key (owner_id, repository)
);
create table if not exists profile_defaults (
  owner_id text primary key,
  profile_id text not null references profiles (id)
);
`;

const sessionTables = `
create table if not exists sessions (
  id text primary key,
  environment_id text not null references environments (id),
  owner_id text not null,
  owner_plugin text,
  owner_key text,
  runner text,
  profile_id text not null,
  workspace text not null,
  model text,
  system_prompt text,
  first_message text,
  thinking text,
  title text,
  status text not null,
  generation integer not null,
  created_at text not null,
  interrupted_at text,
  error text,
  archived_at text,
  workspace_removal text,
  workspace_kept_reason text
);
create table if not exists transcript (
  session_id text not null references sessions (id),
  line integer not null,
  entry text not null,
  primary key (session_id, line)
);
`;

// Databases from before Sessions had a workspace stored a folder path in cwd,
// and ones from before Environments named the provider on each Session.
function migrate(db: DatabaseSync): void {
  db.exec(environmentsTable);
  db.exec(profileTables);

  const environmentColumns = db
    .prepare("select name from pragma_table_info('environments')")
    .all() as { name: string }[];

  for (const [column, empty] of [
    ["setup_script", "''"],
    ["variables", "'{}'"],
    ["secrets", "'{}'"],
  ] as const) {
    if (!environmentColumns.some(({ name }) => name === column)) {
      db.exec(
        `alter table environments add column ${column} text not null default ${empty}`,
      );
    }
  }

  const columns = db
    .prepare("select name from pragma_table_info('sessions')")
    .all() as { name: string }[];

  const sessionsTableExists = columns.length > 0;

  const hasColumn = (name: string): boolean =>
    columns.some((column) => column.name === name);

  if (hasColumn("cwd")) {
    transaction(db, () => {
      db.exec(`
        alter table sessions rename column cwd to workspace;
        update sessions set workspace = json_object('kind', 'folder', 'path', workspace);
      `);
    });
  }

  for (const column of [
    "model",
    "archived_at",
    "workspace_removal",
    "system_prompt",
    "first_message",
    "title",
    "thinking",
    "workspace_kept_reason",
    "owner_plugin",
    "owner_key",
  ]) {
    if (sessionsTableExists && !hasColumn(column)) {
      db.exec(`alter table sessions add column ${column} text`);
    }
  }

  if (hasColumn("provider")) {
    migrateToEnvironments(db);
  }

  // Sessions from before pools ran on the runner named after their
  // Environment (ADR 0032).
  if (sessionsTableExists && !hasColumn("runner")) {
    transaction(db, () => {
      db.exec(`
        alter table sessions add column runner text;
        update sessions set runner = (
          select provider from environments where id = sessions.environment_id
        ) where generation > 0;
      `);
    });
  }

  // Sessions from before Profiles run with the default one.
  const profileId = defaultProfileId(db, owner);
  if (sessionsTableExists && !hasColumn("profile_id")) {
    db.exec(
      `alter table sessions add column profile_id text not null default '${profileId}'`,
    );
  }

  db.exec(sessionTables);
}

// Every owner has a default Profile, which starts empty (ADR 0034).
function defaultProfileId(db: DatabaseSync, ownerId: string): string {
  const found = db
    .prepare("select profile_id from profile_defaults where owner_id = ?")
    .get(ownerId) as { profile_id: string } | undefined;

  if (found) {
    return found.profile_id;
  }

  const id = randomUUID();

  transaction(db, () => {
    db.prepare(
      "insert into profiles (id, owner_id, name, content, created_at) values (?, ?, ?, ?, ?)",
    ).run(
      id,
      ownerId,
      "Default",
      JSON.stringify(emptyProfile),
      new Date().toISOString(),
    );

    db.prepare(
      "insert into profile_defaults (owner_id, profile_id) values (?, ?)",
    ).run(ownerId, id);
  });

  return id;
}

function migrateToEnvironments(db: DatabaseSync): void {
  const providers = db
    .prepare("select distinct provider from sessions")
    .all() as { provider: string }[];

  transaction(db, () => {
    for (const { provider } of providers) {
      insertEnvironment(db, provider);
    }

    db.exec(`
      alter table sessions add column environment_id text references environments (id);
      alter table sessions add column owner_id text;
      update sessions set
        environment_id = (select id from environments where provider = sessions.provider),
        owner_id = '${owner}';
      alter table sessions drop column provider;
    `);
  });
}

function insertEnvironment(db: DatabaseSync, provider: string): void {
  db.prepare(
    "insert into environments (id, name, provider, owner_id, created_at) values (?, ?, ?, ?, ?) on conflict (provider) do nothing",
  ).run(randomUUID(), provider, provider, owner, new Date().toISOString());
}

function transaction(db: DatabaseSync, run: () => void): void {
  db.exec("begin");
  try {
    run();
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function openStore(path: string): SessionStore &
  ProfileStore & {
    check: () => void;
    close: () => void;
    plugin: (name: string) => PluginStore;
  } {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal");
  migrate(db);

  const toSession = (row: SessionRow): StoredSession => ({
    id: row.id,
    environmentId: row.environment_id,
    ownerId: row.owner_id,
    owner:
      row.owner_plugin === null || row.owner_key === null
        ? null
        : { plugin: row.owner_plugin, key: row.owner_key },
    provider: row.provider,
    runner: row.runner,
    profileId: row.profile_id,
    workspace: JSON.parse(row.workspace) as Workspace,
    model: row.model === null ? null : (JSON.parse(row.model) as ModelRef),
    systemPrompt: row.system_prompt,
    thinking: row.thinking,
    firstMessage: row.first_message,
    title: row.title,
    status: row.status,
    generation: row.generation,
    createdAt: row.created_at,
    interruptedAt: row.interrupted_at,
    error: row.error,
    archivedAt: row.archived_at,
    workspaceRemoval: row.workspace_removal,
    workspaceKeptReason: row.workspace_kept_reason,
  });

  const insertSession = db.prepare(
    "insert into sessions (id, environment_id, owner_id, owner_plugin, owner_key, runner, profile_id, workspace, model, system_prompt, first_message, thinking, title, status, generation, created_at, interrupted_at, error, archived_at, workspace_removal, workspace_kept_reason) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const updateSession = db.prepare(
    "update sessions set runner = ?, workspace = ?, status = ?, generation = ?, interrupted_at = ?, error = ?, archived_at = ?, workspace_removal = ?, workspace_kept_reason = ? where id = ?",
  );

  const selectAnySession = db.prepare("select 1 from sessions limit 1");

  const withProvider =
    "select sessions.*, environments.provider from sessions join environments on environments.id = sessions.environment_id";

  const selectSession = db.prepare(`${withProvider} where sessions.id = ?`);

  const selectSessions = db.prepare(
    `${withProvider} order by sessions.created_at desc`,
  );

  const selectUnarchivedSessions = db.prepare(
    `${withProvider} where sessions.archived_at is null order by sessions.created_at desc`,
  );

  const selectOwnedSessions = db.prepare(
    `${withProvider} where owner_plugin = ? and owner_key = ? order by sessions.created_at desc`,
  );

  const selectUnarchivedOwnedSessions = db.prepare(
    `${withProvider} where owner_plugin = ? and owner_key = ? and sessions.archived_at is null order by sessions.created_at desc`,
  );

  const updateOwner = db.prepare(
    "update sessions set owner_plugin = ?, owner_key = ? where id = ?",
  );

  const selectByEnvironment = db.prepare(
    `${withProvider} where environments.provider = ? and status in (select value from json_each(?)) order by sessions.created_at`,
  );

  const selectByRunner = db.prepare(
    `${withProvider} where runner = ? and status in (select value from json_each(?)) order by sessions.created_at`,
  );

  const selectPendingRemovals = db.prepare(
    `${withProvider} where (runner = ? or (runner is null and environments.provider = ?)) and status = ? and workspace_removal in (?, ?) order by sessions.created_at`,
  );

  const toEnvironment = (row: EnvironmentRow): StoredEnvironment => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    setupScript: row.setup_script,
    variables: JSON.parse(row.variables) as Record<string, string>,
    secrets: JSON.parse(row.secrets) as Record<string, string>,
  });

  const updateEnvironment = db.prepare(
    "update environments set name = ?, setup_script = ?, variables = ?, secrets = ? where id = ?",
  );

  const selectEnvironments = db.prepare(
    "select * from environments order by created_at, name",
  );

  const countTranscript = db.prepare(
    "select count(*) as n from transcript where session_id = ?",
  );

  const insertTranscriptLine = db.prepare(
    "insert into transcript (session_id, line, entry) values (?, ?, ?)",
  );

  const updateTitle = db.prepare("update sessions set title = ? where id = ?");
  const updateModel = db.prepare("update sessions set model = ? where id = ?");

  const toProfile = (row: ProfileRow): StoredProfile => ({
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    createdAt: row.created_at,
    ...(JSON.parse(row.content) as ProfileContent),
  });

  const contentJson = ({
    packages,
    agentsMd,
    systemMd,
    appendSystemMd,
    mcpServers,
    settings,
  }: ProfileContent): string =>
    JSON.stringify({
      packages,
      agentsMd,
      systemMd,
      appendSystemMd,
      mcpServers,
      settings,
    } satisfies ProfileContent);

  const selectProfiles = db.prepare(
    "select * from profiles where owner_id = ? order by created_at, name",
  );

  const selectProfile = db.prepare("select * from profiles where id = ?");

  const insertProfile = db.prepare(
    "insert into profiles (id, owner_id, name, content, created_at) values (?, ?, ?, ?, ?)",
  );

  const updateProfile = db.prepare(
    "update profiles set name = ?, content = ? where id = ?",
  );

  const deleteProfile = db.prepare("delete from profiles where id = ?");

  const upsertDefault = db.prepare(
    "insert into profile_defaults (owner_id, profile_id) values (?, ?) on conflict (owner_id) do update set profile_id = excluded.profile_id",
  );

  const selectProfileUse = db.prepare(
    "select 1 from sessions where profile_id = ? and archived_at is null limit 1",
  );

  const selectTrust = db.prepare(
    "select trusted from repository_trust where owner_id = ? and repository = ?",
  );

  const upsertTrust = db.prepare(
    "insert into repository_trust (owner_id, repository, trusted) values (?, ?, ?) on conflict (owner_id, repository) do update set trusted = excluded.trusted",
  );

  const selectTranscript = db.prepare(
    "select entry from transcript where session_id = ? and line >= ? order by line",
  );

  return {
    insert: (s) => {
      insertSession.run(
        s.id,
        s.environmentId,
        s.ownerId,
        s.owner?.plugin ?? null,
        s.owner?.key ?? null,
        s.runner,
        s.profileId,
        JSON.stringify(s.workspace),
        s.model && JSON.stringify(s.model),
        s.systemPrompt,
        s.firstMessage,
        s.thinking,
        s.title,
        s.status,
        s.generation,
        s.createdAt,
        s.interruptedAt,
        s.error,
        s.archivedAt,
        s.workspaceRemoval,
        s.workspaceKeptReason,
      );
    },
    update: (s) => {
      updateSession.run(
        s.runner,
        JSON.stringify(s.workspace),
        s.status,
        s.generation,
        s.interruptedAt,
        s.error,
        s.archivedAt,
        s.workspaceRemoval,
        s.workspaceKeptReason,
        s.id,
      );
    },
    get: (id) => {
      const row = selectSession.get(id) as SessionRow | undefined;

      return row && toSession(row);
    },
    list: ({ includeArchived, owner: ownedBy }) => {
      const rows = ownedBy
        ? (includeArchived
            ? selectOwnedSessions
            : selectUnarchivedOwnedSessions
          ).all(ownedBy.plugin, ownedBy.key)
        : (includeArchived ? selectSessions : selectUnarchivedSessions).all();

      return (rows as unknown as SessionRow[]).map(toSession);
    },
    setOwner: (id, { plugin, key }: SessionOwner) => {
      updateOwner.run(plugin, key, id);
    },
    byEnvironment: (provider, statuses) =>
      (
        selectByEnvironment.all(
          provider,
          JSON.stringify(statuses),
        ) as unknown as SessionRow[]
      ).map(toSession),
    byRunner: (runner, statuses) =>
      (
        selectByRunner.all(
          runner,
          JSON.stringify(statuses),
        ) as unknown as SessionRow[]
      ).map(toSession),
    pendingRemovals: (provider, runner) =>
      (
        selectPendingRemovals.all(
          runner,
          provider,
          "stopped" satisfies SessionStatus,
          "pending" satisfies WorkspaceRemoval,
          "forced" satisfies WorkspaceRemoval,
        ) as unknown as SessionRow[]
      ).map(toSession),
    ensureEnvironment: (provider) => {
      insertEnvironment(db, provider);
    },
    environments: () =>
      (selectEnvironments.all() as unknown as EnvironmentRow[]).map(
        toEnvironment,
      ),
    updateEnvironment: (environment) => {
      updateEnvironment.run(
        environment.name,
        environment.setupScript,
        JSON.stringify(environment.variables),
        JSON.stringify(environment.secrets),
        environment.id,
      );
    },
    transcriptLength: (id) => (countTranscript.get(id) as { n: number }).n,
    appendTranscript: (id, start, lines) => {
      transaction(db, () => {
        lines.forEach((entry, i) =>
          insertTranscriptLine.run(id, start + i, entry),
        );
      });
    },
    setModel: (id, model) => {
      updateModel.run(JSON.stringify(model), id);
    },
    setTitle: (id, title) => {
      updateTitle.run(title, id);
    },
    transcript: (id, from) =>
      (selectTranscript.all(id, from) as { entry: string }[]).map(
        (r) => r.entry,
      ),
    check: () => {
      selectAnySession.get();
    },
    profiles: (ownerId) =>
      (selectProfiles.all(ownerId) as unknown as ProfileRow[]).map(toProfile),
    profile: (id) => {
      const row = selectProfile.get(id) as ProfileRow | undefined;

      return row && toProfile(row);
    },
    insertProfile: (profile) => {
      insertProfile.run(
        profile.id,
        profile.ownerId,
        profile.name,
        contentJson(profile),
        profile.createdAt,
      );
    },
    updateProfile: (profile) => {
      updateProfile.run(profile.name, contentJson(profile), profile.id);
    },
    deleteProfile: (id) => {
      deleteProfile.run(id);
    },
    defaultProfileId: (ownerId) => defaultProfileId(db, ownerId),
    setDefaultProfile: (ownerId, id) => {
      upsertDefault.run(ownerId, id);
    },
    repositoryTrust: (ownerId, repository) => {
      const row = selectTrust.get(ownerId, repository) as
        { trusted: number } | undefined;

      return row === undefined ? null : row.trusted === 1;
    },
    setRepositoryTrust: (ownerId, repository, trusted) => {
      upsertTrust.run(ownerId, repository, trusted ? 1 : 0);
    },
    profileInUse: (id) => selectProfileUse.get(id) !== undefined,
    plugin: (name) => pluginStore(db, name),
    close: () => {
      db.close();
    },
  };
}

const createdTable = /create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?(\w+)/gi;

// Plugins are trusted in v1, so this only keeps their tables apart by name.
function pluginStore(db: DatabaseSync, name: string): PluginStore {
  return {
    exec: (sql) => {
      for (const [, table = ""] of sql.matchAll(createdTable)) {
        if (!table.startsWith(`${name}_`)) {
          throw new Error(`plugin ${name} may only create ${name}_ tables`);
        }
      }

      db.exec(sql);
    },
    all: (sql, ...params) => db.prepare(sql).all(...params),
    run: (sql, ...params) => {
      db.prepare(sql).run(...params);
    },
  };
}
