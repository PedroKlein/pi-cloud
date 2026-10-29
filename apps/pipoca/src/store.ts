import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ModelRef,
  ProfileContent,
  SessionOwner,
  SessionStatus,
  ThinkingLevel,
  Workspace,
  WorkspaceRemoval,
} from "@pipoca/protocol";
import type { PluginStore } from "@pipoca/plugins";
import type { PluginSettingsStore } from "@pipoca/pluginhost";
import {
  defaultProfileId as sharedDefault,
  type ProfileFolders,
  type ProfileStore,
} from "@pipoca/profiles";
import type { AuthStore, User } from "./auth";
import { fileSecretKey, SecretBox } from "./secret-box";
import {
  owner,
  type SessionStore,
  type StoredEnvironment,
  type StoredSession,
} from "@pipoca/sessions";

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
  started_by: string | null;
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
  isolation: string;
  image: string | null;
  setup_script: string;
  variables: string;
  secrets: string;
  key_hash: string | null;
}

const environmentsTable = `
create table if not exists environments (
  id text primary key,
  name text not null,
  provider text not null unique,
  owner_id text not null,
  created_at text not null,
  isolation text not null default 'process',
  image text,
  setup_script text not null default '',
  variables text not null default '{}',
  secrets text not null default '{}',
  key_hash text unique
);
create table if not exists runner_models (
  provider text not null,
  runner text not null,
  models text not null,
  reported_at text not null,
  primary key (provider, runner)
);
`;

const profileTables = `
create table if not exists repository_trust (
  owner_id text not null,
  repository text not null,
  trusted integer not null,
  primary key (owner_id, repository)
);
create table if not exists profile_defaults (
  owner_id text primary key,
  profile_id text not null
);
`;

const authTables = `
create table if not exists users (
  id text primary key,
  name text not null unique,
  password_hash text not null,
  created_at text not null,
  admin integer not null default 0,
  pinned_pages text
);
create table if not exists agent_tokens (
  token_hash text primary key,
  environment text not null,
  runner text not null,
  session_id text,
  joined integer not null default 1,
  last_used text not null
);
create table if not exists join_keys (
  key_hash text primary key,
  created_at text not null,
  owner_id text not null
);
create table if not exists browser_sessions (
  token_hash text primary key,
  user_id text not null references users (id),
  expires_at text not null
);
create table if not exists mcp_tokens (
  id text primary key,
  token_hash text not null unique,
  user_id text not null references users (id),
  name text not null,
  created_at text not null
);
`;

const pluginTables = `
create table if not exists plugin_settings (
  plugin text primary key,
  settings text not null
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
  workspace_kept_reason text,
  started_by text
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
  db.exec(authTables);
  db.exec(pluginTables);

  const userColumns = db
    .prepare("select name from pragma_table_info('users')")
    .all() as { name: string }[];

  // Every user so far was the first one, made from the setup link.
  if (!userColumns.some(({ name }) => name === "admin")) {
    db.exec(`
      alter table users add column admin integer not null default 0;
      update users set admin = 1;
    `);
  }

  if (!userColumns.some(({ name }) => name === "pinned_pages")) {
    db.exec("alter table users add column pinned_pages text");
  }

  // A join key from before keys had a person makes the first user's
  // Environment, as an Environment from then is (ADR 0049).
  const joinKeyColumns = db
    .prepare("select name from pragma_table_info('join_keys')")
    .all() as { name: string }[];

  if (!joinKeyColumns.some(({ name }) => name === "owner_id")) {
    db.exec(
      `alter table join_keys add column owner_id text not null default '${owner}'`,
    );
  }

  const tokenColumns = db
    .prepare("select name from pragma_table_info('agent_tokens')")
    .all() as { name: string }[];

  if (!tokenColumns.some(({ name }) => name === "joined")) {
    db.exec(
      "alter table agent_tokens add column joined integer not null default 1",
    );
  }

  // Tokens from before runner tokens expired count as used now.
  if (!tokenColumns.some(({ name }) => name === "last_used")) {
    transaction(db, () => {
      db.exec(
        "alter table agent_tokens add column last_used text not null default ''",
      );

      db.prepare("update agent_tokens set last_used = ?").run(
        new Date().toISOString(),
      );
    });
  }

  const environmentColumns = db
    .prepare("select name from pragma_table_info('environments')")
    .all() as { name: string }[];

  for (const [column, definition] of [
    ["isolation", "text not null default 'process'"],
    ["image", "text"],
    ["setup_script", "text not null default ''"],
    ["variables", "text not null default '{}'"],
    ["secrets", "text not null default '{}'"],
    ["key_hash", "text"],
  ] as const) {
    if (!environmentColumns.some(({ name }) => name === column)) {
      db.exec(`alter table environments add column ${column} ${definition}`);
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
    "started_by",
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
  if (sessionsTableExists && !hasColumn("profile_id")) {
    db.exec(
      `alter table sessions add column profile_id text not null default '${defaultProfileId(db, owner)}'`,
    );
  }

  db.exec(sessionTables);
}

// Owners use the shared default Profile until they pick another (ADR 0041).
function defaultProfileId(db: DatabaseSync, ownerId: string): string {
  const found = db
    .prepare("select profile_id from profile_defaults where owner_id = ?")
    .get(ownerId) as { profile_id: string } | undefined;

  return found?.profile_id ?? sharedDefault;
}

// Profiles were rows before they were folders (ADR 0041). Each becomes a
// folder named after it, and what pointed at its old id points at the folder.
// The empty Default Profile every owner got points at the shared one instead.
function moveProfilesToFolders(
  db: DatabaseSync,
  folders: ProfileFolders | undefined,
): void {
  const legacy = db
    .prepare(
      "select name from sqlite_master where type = 'table' and name = 'profiles'",
    )
    .get();

  if (legacy === undefined) {
    return;
  }

  const rows = db
    .prepare("select * from profiles order by created_at, name")
    .all() as unknown as ProfileRow[];

  if (rows.length > 0 && folders === undefined) {
    throw new Error(
      "the database holds Profiles and has no folder to move them to",
    );
  }

  const moved = new Map(
    folders === undefined
      ? []
      : rows.map((row) => [row.id, moveProfile(row, folders)] as const),
  );

  const projects = db
    .prepare(
      "select name from sqlite_master where type = 'table' and name = 'projects_projects'",
    )
    .get();

  transaction(db, () => {
    // The old table's profile_id referenced Profile rows, which would refuse
    // the folder ids.
    db.exec(`
      create table profile_defaults_moved (
        owner_id text primary key,
        profile_id text not null
      );
      insert into profile_defaults_moved select owner_id, profile_id from profile_defaults;
      drop table profile_defaults;
      alter table profile_defaults_moved rename to profile_defaults;
    `);

    for (const [from, to] of moved) {
      db.prepare("update sessions set profile_id = ? where profile_id = ?").run(
        to,
        from,
      );

      db.prepare(
        "update profile_defaults set profile_id = ? where profile_id = ?",
      ).run(to, from);

      if (projects !== undefined) {
        db.prepare(
          "update projects_projects set profile_id = ? where profile_id = ?",
        ).run(to, from);
      }
    }

    db.exec("drop table profiles");
  });
}

// Profiles and the default Profile belonged to one server-wide owner before
// each user had their own (ADR 0041). A sole user takes them over. With
// several users nobody knows whose a Profile was, so it becomes shared, and
// each user keeps the old default until they pick another.
function giveProfilesToUsers(
  db: DatabaseSync,
  folders: ProfileFolders | undefined,
): void {
  const users = db
    .prepare("select id from users order by created_at")
    .all() as { id: string }[];

  if (users.length === 0) {
    return;
  }

  const sole = users.length === 1 ? (users[0]?.id ?? null) : null;

  for (const id of folders?.ids() ?? []) {
    const profile = folders?.read(id);

    if (profile?.ownerId === owner) {
      folders?.write(
        id,
        { name: profile.name, ownerId: sole, createdAt: profile.createdAt },
        {},
      );
    }
  }

  transaction(db, () => {
    db.prepare(
      "insert or ignore into profile_defaults (owner_id, profile_id) select users.id, old.profile_id from users, profile_defaults old where old.owner_id = ?",
    ).run(owner);

    db.prepare("delete from profile_defaults where owner_id = ?").run(owner);
  });
}

function moveProfile(row: ProfileRow, folders: ProfileFolders): string {
  const content = JSON.parse(row.content) as ProfileContent;
  if (row.name === "Default" && isEmpty(content)) {
    return sharedDefault;
  }

  // A move cut short left some folders behind, which are used again.
  const written = folders.ids().find((id) => {
    const profile = folders.read(id);

    return (
      profile?.createdAt === row.created_at &&
      profile.ownerId === row.owner_id &&
      profile.name === row.name
    );
  });

  const id = written ?? folders.freeId(row.name);

  folders.write(
    id,
    { name: row.name, ownerId: row.owner_id, createdAt: row.created_at },
    content,
  );

  return id;
}

function isEmpty(content: ProfileContent): boolean {
  return (
    content.packages.length === 0 &&
    content.agentsMd === "" &&
    content.systemMd === "" &&
    content.appendSystemMd === "" &&
    Object.keys(content.mcpServers).length === 0 &&
    Object.keys(content.settings).length === 0
  );
}

function migrateToEnvironments(db: DatabaseSync): void {
  const providers = db
    .prepare("select distinct provider from sessions")
    .all() as { provider: string }[];

  transaction(db, () => {
    for (const { provider } of providers) {
      insertEnvironment(db, provider, owner);
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

function insertEnvironment(
  db: DatabaseSync,
  provider: string,
  ownerId: string,
): void {
  db.prepare(
    "insert into environments (id, name, provider, owner_id, created_at) values (?, ?, ?, ?, ?) on conflict (provider) do nothing",
  ).run(randomUUID(), provider, provider, ownerId, new Date().toISOString());
}

// Seals secrets stored before they were encrypted, and fails the start when
// the key doesn't open the ones already sealed.
function sealSecrets(db: DatabaseSync, box: SecretBox): void {
  const rows = db.prepare("select id, secrets from environments").all() as {
    id: string;
    secrets: string;
  }[];

  const seal = db.prepare("update environments set secrets = ? where id = ?");

  transaction(db, () => {
    for (const { id, secrets } of rows) {
      if (SecretBox.isSealed(secrets)) {
        box.open(secrets, id);
      } else {
        seal.run(box.seal(secrets, id), id);
      }
    }
  });
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

export function openStore(
  path: string,
  secretKey?: Buffer,
  profiles?: ProfileFolders,
): SessionStore &
  ProfileStore & {
    auth: AuthStore;
    check: () => void;
    close: () => void;
    plugin: (name: string) => PluginStore;
    pluginSettings: PluginSettingsStore;
  } {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const box = new SecretBox(
    secretKey ??
      (path === ":memory:" ? randomBytes(32) : fileSecretKey(`${path}.key`)),
  );

  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal");
  migrate(db);
  moveProfilesToFolders(db, profiles);
  giveProfilesToUsers(db, profiles);
  sealSecrets(db, box);

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
    startedBy: row.started_by,
  });

  const insertSession = db.prepare(
    "insert into sessions (id, environment_id, owner_id, owner_plugin, owner_key, runner, profile_id, workspace, model, system_prompt, first_message, thinking, title, status, generation, created_at, interrupted_at, error, archived_at, workspace_removal, workspace_kept_reason, started_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    `${withProvider} where environments.provider = ? and runner = ? and status in (select value from json_each(?)) order by sessions.created_at`,
  );

  const selectPendingRemovals = db.prepare(
    `${withProvider} where environments.provider = ? and (runner = ? or runner is null) and status = ? and workspace_removal in (?, ?) order by sessions.created_at`,
  );

  const selectFirstUser = db.prepare(
    "select id from users order by created_at limit 1",
  );

  // An Environment from before each one had a person, or one a runner made
  // with a join key, is the person the setup link made (ADR 0049).
  const toEnvironment = (row: EnvironmentRow): StoredEnvironment => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    ownerId:
      row.owner_id === owner
        ? ((selectFirstUser.get() as { id: string } | undefined)?.id ?? owner)
        : row.owner_id,
    createdAt: row.created_at,
    isolation: row.isolation === "container" ? "container" : "process",
    image: row.image,
    setupScript: row.setup_script,
    variables: JSON.parse(row.variables) as Record<string, string>,
    secrets: JSON.parse(
      SecretBox.isSealed(row.secrets)
        ? box.open(row.secrets, row.id)
        : row.secrets,
    ) as Record<string, string>,
    hasKey: row.key_hash !== null,
  });

  const updateEnvironment = db.prepare(
    "update environments set name = ?, isolation = ?, image = ?, setup_script = ?, variables = ?, secrets = ? where id = ?",
  );

  const selectEnvironments = db.prepare(
    "select * from environments order by created_at, name",
  );

  const selectRunnerModels = db.prepare(
    "select models from runner_models where provider = ? order by reported_at",
  );

  const upsertRunnerModels = db.prepare(
    `insert into runner_models (provider, runner, models, reported_at) values (?, ?, ?, ?)
     on conflict (provider, runner) do update set models = excluded.models, reported_at = excluded.reported_at`,
  );

  // Runners started on demand each have a name of their own, so what the
  // ones gone for a month reported is dropped.
  const deleteOldRunnerModels = db.prepare(
    "delete from runner_models where reported_at < ?",
  );

  const countTranscript = db.prepare(
    "select count(*) as n from transcript where session_id = ?",
  );

  const insertTranscriptLine = db.prepare(
    "insert into transcript (session_id, line, entry) values (?, ?, ?)",
  );

  const updateTitle = db.prepare("update sessions set title = ? where id = ?");
  const updateModel = db.prepare("update sessions set model = ? where id = ?");

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
        s.startedBy,
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
    byRunner: (provider, runner, statuses) =>
      (
        selectByRunner.all(
          provider,
          runner,
          JSON.stringify(statuses),
        ) as unknown as SessionRow[]
      ).map(toSession),
    pendingRemovals: (provider, runner) =>
      (
        selectPendingRemovals.all(
          provider,
          runner,
          "stopped" satisfies SessionStatus,
          "pending" satisfies WorkspaceRemoval,
          "forced" satisfies WorkspaceRemoval,
        ) as unknown as SessionRow[]
      ).map(toSession),
    ensureEnvironment: (provider, ownerId = owner) => {
      insertEnvironment(db, provider, ownerId);
    },
    environments: () =>
      (selectEnvironments.all() as unknown as EnvironmentRow[]).map(
        toEnvironment,
      ),
    registeredModels: (provider) =>
      (selectRunnerModels.all(provider) as { models: string }[]).flatMap(
        ({ models }) => JSON.parse(models) as ModelRef[],
      ),
    setRegisteredModels: (provider, runner, models) => {
      const now = new Date();

      upsertRunnerModels.run(
        provider,
        runner,
        JSON.stringify(models),
        now.toISOString(),
      );

      deleteOldRunnerModels.run(
        new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      );
    },
    updateEnvironment: (environment) => {
      updateEnvironment.run(
        environment.name,
        environment.isolation,
        environment.image,
        environment.setupScript,
        JSON.stringify(environment.variables),
        box.seal(JSON.stringify(environment.secrets), environment.id),
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
    profile: (id) => profiles?.read(id),
    profileFiles: (id) => profiles?.files(id),
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
    auth: authStore(db),
    plugin: (name) => pluginStore(db, name, box),
    pluginSettings: pluginSettingsStore(db),
    close: () => {
      db.close();
    },
  };
}

interface UserRow {
  readonly id: string;
  readonly name: string;
  readonly admin: number;
}

function userOf(row: UserRow | undefined): User | undefined {
  return row && { id: row.id, name: row.name, admin: row.admin === 1 };
}

function authStore(db: DatabaseSync): AuthStore {
  const countUsers = db.prepare("select count(*) as n from users");

  const selectUser = db.prepare(
    "select id, name, password_hash, created_at, admin from users where name = ?",
  );

  const selectUserById = db.prepare(
    "select id, name, admin from users where id = ?",
  );

  const insertUser = db.prepare(
    "insert into users (id, name, password_hash, created_at, admin) values (?, ?, ?, ?, ?)",
  );

  const updateAdmin = db.prepare("update users set admin = ? where id = ?");

  const insertBrowserSession = db.prepare(
    "insert into browser_sessions (token_hash, user_id, expires_at) values (?, ?, ?)",
  );

  const selectBrowserSessionUser = db.prepare(
    "select users.id, users.name, users.admin from browser_sessions join users on users.id = browser_sessions.user_id where token_hash = ? and expires_at > ?",
  );

  const deleteBrowserSession = db.prepare(
    "delete from browser_sessions where token_hash = ?",
  );

  const deleteExpired = db.prepare(
    "delete from browser_sessions where expires_at <= ?",
  );

  const updateKey = db.prepare(
    "update environments set key_hash = ? where provider = ?",
  );

  const insertJoinKey = db.prepare(
    "insert into join_keys (key_hash, created_at, owner_id) values (?, ?, ?)",
  );

  const selectJoinKey = db.prepare(
    "select owner_id from join_keys where key_hash = ?",
  );

  const deleteJoinKey = db.prepare("delete from join_keys where key_hash = ?");

  const selectKeyEnvironment = db.prepare(
    "select provider from environments where key_hash = ?",
  );

  const insertAgentToken = db.prepare(
    "insert into agent_tokens (token_hash, environment, runner, session_id, joined, last_used) values (?, ?, ?, ?, ?, ?)",
  );

  const selectAgentToken = db.prepare(
    "select environment, runner, session_id, joined, last_used from agent_tokens where token_hash = ?",
  );

  const updateLastUsed = db.prepare(
    "update agent_tokens set last_used = ? where token_hash = ?",
  );

  const deleteJoinedTokens = db.prepare(
    "delete from agent_tokens where environment = ? and joined = 1",
  );

  const deleteRunnerTokens = db.prepare(
    "delete from agent_tokens where environment = ? and runner = ?",
  );

  const deleteSessionTokens = db.prepare(
    "delete from agent_tokens where session_id = ?",
  );

  const deleteUnusedRunnerTokens = db.prepare(
    "delete from agent_tokens where session_id is null and last_used < ?",
  );

  const deleteOrphanedSessionTokens = db.prepare(`
    delete from agent_tokens where session_id is not null and not exists (
      select 1 from agent_tokens runners
      where runners.session_id is null
        and runners.environment = agent_tokens.environment
        and runners.runner = agent_tokens.runner
    )
  `);

  const insertMcpToken = db.prepare(
    "insert into mcp_tokens (id, token_hash, user_id, name, created_at) values (?, ?, ?, ?, ?)",
  );

  const selectPinnedPages = db.prepare(
    "select pinned_pages from users where id = ?",
  );

  const updatePinnedPages = db.prepare(
    "update users set pinned_pages = ? where id = ?",
  );

  const selectMcpTokens = db.prepare(
    "select id, name, created_at from mcp_tokens where user_id = ? order by created_at",
  );

  const selectMcpTokenUser = db.prepare(
    "select users.id, users.name, users.admin from mcp_tokens join users on users.id = mcp_tokens.user_id where token_hash = ?",
  );

  const deleteMcpToken = db.prepare(
    "delete from mcp_tokens where id = ? and user_id = ?",
  );

  return {
    userCount: () => (countUsers.get() as { n: number }).n,
    userByName: (name) => {
      const row = selectUser.get(name) as
        | {
            id: string;
            name: string;
            password_hash: string;
            created_at: string;
            admin: number;
          }
        | undefined;

      return (
        row && {
          id: row.id,
          name: row.name,
          admin: row.admin === 1,
          passwordHash: row.password_hash,
          createdAt: row.created_at,
        }
      );
    },
    userById: (id) => userOf(selectUserById.get(id) as UserRow | undefined),
    insertUser: (user) => {
      insertUser.run(
        user.id,
        user.name,
        user.passwordHash,
        user.createdAt,
        user.admin ? 1 : 0,
      );
    },
    setAdmin: (id, admin) => {
      updateAdmin.run(admin ? 1 : 0, id);
    },
    insertBrowserSession: (tokenHash, userId, expiresAt) => {
      deleteExpired.run(new Date().toISOString());
      insertBrowserSession.run(tokenHash, userId, expiresAt);
    },
    browserSessionUser: (tokenHash, now) =>
      userOf(
        selectBrowserSessionUser.get(tokenHash, now) as UserRow | undefined,
      ),
    deleteBrowserSession: (tokenHash) => {
      deleteBrowserSession.run(tokenHash);
    },
    setEnvironmentKey: (provider, keyHash) => {
      transaction(db, () => {
        updateKey.run(keyHash, provider);
        deleteJoinedTokens.run(provider);
      });
    },
    insertJoinKey: (keyHash, ownerId) => {
      insertJoinKey.run(keyHash, new Date().toISOString(), ownerId);
    },
    joinKeyOwner: (keyHash) =>
      (selectJoinKey.get(keyHash) as { owner_id: string } | undefined)
        ?.owner_id,
    claimJoinKey: (keyHash, provider) => {
      transaction(db, () => {
        deleteJoinKey.run(keyHash);
        updateKey.run(keyHash, provider);
      });
    },
    keyEnvironment: (keyHash) =>
      (selectKeyEnvironment.get(keyHash) as { provider: string } | undefined)
        ?.provider,
    insertAgentToken: (tokenHash, holder, now) => {
      transaction(db, () => {
        if (holder.sessionId !== null) {
          deleteSessionTokens.run(holder.sessionId);
        }

        insertAgentToken.run(
          tokenHash,
          holder.environment,
          holder.runner,
          holder.sessionId,
          holder.joined ? 1 : 0,
          now,
        );
      });
    },
    useAgentToken: (tokenHash, now) => {
      updateLastUsed.run(now, tokenHash);
    },
    deleteUnusedAgentTokens: (usedBefore) => {
      transaction(db, () => {
        deleteUnusedRunnerTokens.run(usedBefore);
        deleteOrphanedSessionTokens.run();
      });
    },
    deleteRunnerTokens: (provider, runner) => {
      deleteRunnerTokens.run(provider, runner);
    },
    insertMcpToken: (token, tokenHash) => {
      insertMcpToken.run(
        token.id,
        tokenHash,
        token.userId,
        token.name,
        token.createdAt,
      );
    },
    mcpTokens: (userId) =>
      (
        selectMcpTokens.all(userId) as {
          id: string;
          name: string;
          created_at: string;
        }[]
      ).map((row) => ({
        id: row.id,
        userId,
        name: row.name,
        createdAt: row.created_at,
      })),
    mcpTokenUser: (tokenHash) =>
      userOf(selectMcpTokenUser.get(tokenHash) as UserRow | undefined),
    deleteMcpToken: (id, userId) =>
      Number(deleteMcpToken.run(id, userId).changes) > 0,
    pinnedPages: (userId) => {
      const row = selectPinnedPages.get(userId) as
        { pinned_pages: string | null } | undefined;

      return row?.pinned_pages === undefined || row.pinned_pages === null
        ? null
        : (JSON.parse(row.pinned_pages) as string[]);
    },
    setPinnedPages: (userId, pages) => {
      updatePinnedPages.run(
        pages === null ? null : JSON.stringify(pages),
        userId,
      );
    },
    agentToken: (tokenHash) => {
      const row = selectAgentToken.get(tokenHash) as
        | {
            environment: string;
            runner: string;
            session_id: string | null;
            joined: number;
            last_used: string;
          }
        | undefined;

      return (
        row && {
          agent: {
            environment: row.environment,
            runner: row.runner,
            sessionId: row.session_id,
            joined: row.joined === 1,
          },
          lastUsed: row.last_used,
        }
      );
    },
  };
}

function pluginSettingsStore(db: DatabaseSync): PluginSettingsStore {
  const select = db.prepare(
    "select settings from plugin_settings where plugin = ?",
  );

  const upsert = db.prepare(
    `insert into plugin_settings (plugin, settings) values (?, ?)
     on conflict (plugin) do update set settings = excluded.settings`,
  );

  return {
    get: (plugin) => {
      const row = select.get(plugin) as { settings: string } | undefined;

      return row === undefined
        ? undefined
        : (JSON.parse(row.settings) as unknown);
    },
    set: (plugin, settings) => {
      upsert.run(plugin, JSON.stringify(settings));
    },
  };
}

// A plugin whose id has a hyphen quotes its table names.
const createdTable =
  /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:["`]([\w-]+)["`]|(\w+))/gi;

// Plugins are trusted in v1, so this only keeps their tables apart by name.
function pluginStore(
  db: DatabaseSync,
  name: string,
  box: SecretBox,
): PluginStore {
  return {
    exec: (sql) => {
      for (const [, quoted, bare = ""] of sql.matchAll(createdTable)) {
        const table = quoted ?? bare;

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
    seal: (text, context) => box.seal(text, `plugin:${name}:${context}`),
    open: (sealed, context) => box.open(sealed, `plugin:${name}:${context}`),
  };
}
