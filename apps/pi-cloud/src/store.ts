import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ModelRef,
  SessionStatus,
  ThinkingLevel,
  Workspace,
  WorkspaceRemoval,
} from "@pi-cloud/protocol";
import type { PluginStore } from "@pi-cloud/plugins";
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
  provider: string;
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
}

interface EnvironmentRow {
  id: string;
  name: string;
  provider: string;
  owner_id: string;
  created_at: string;
}

const environmentsTable = `
create table if not exists environments (
  id text primary key,
  name text not null,
  provider text not null unique,
  owner_id text not null,
  created_at text not null
);
`;

const sessionTables = `
create table if not exists sessions (
  id text primary key,
  environment_id text not null references environments (id),
  owner_id text not null,
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
  workspace_removal text
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
  ]) {
    if (sessionsTableExists && !hasColumn(column)) {
      db.exec(`alter table sessions add column ${column} text`);
    }
  }

  if (hasColumn("provider")) {
    migrateToEnvironments(db);
  }

  db.exec(sessionTables);
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

export function openStore(path: string): SessionStore & {
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
    provider: row.provider,
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
  });

  const insertSession = db.prepare(
    "insert into sessions (id, environment_id, owner_id, workspace, model, system_prompt, first_message, thinking, title, status, generation, created_at, interrupted_at, error, archived_at, workspace_removal) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const updateSession = db.prepare(
    "update sessions set workspace = ?, status = ?, generation = ?, interrupted_at = ?, error = ?, archived_at = ?, workspace_removal = ? where id = ?",
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

  const selectByProvider = db.prepare(
    `${withProvider} where environments.provider = ? and status in (select value from json_each(?)) order by sessions.created_at`,
  );

  const selectPendingRemovals = db.prepare(
    `${withProvider} where environments.provider = ? and status = ? and workspace_removal in (?, ?) order by sessions.created_at`,
  );

  const toEnvironment = (row: EnvironmentRow): StoredEnvironment => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    ownerId: row.owner_id,
    createdAt: row.created_at,
  });

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

  const selectTranscript = db.prepare(
    "select entry from transcript where session_id = ? and line >= ? order by line",
  );

  return {
    insert: (s) => {
      insertSession.run(
        s.id,
        s.environmentId,
        s.ownerId,
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
      );
    },
    update: (s) => {
      updateSession.run(
        JSON.stringify(s.workspace),
        s.status,
        s.generation,
        s.interruptedAt,
        s.error,
        s.archivedAt,
        s.workspaceRemoval,
        s.id,
      );
    },
    get: (id) => {
      const row = selectSession.get(id) as SessionRow | undefined;

      return row && toSession(row);
    },
    list: ({ includeArchived }) =>
      (
        (includeArchived
          ? selectSessions
          : selectUnarchivedSessions
        ).all() as unknown as SessionRow[]
      ).map(toSession),
    byProvider: (provider, statuses) =>
      (
        selectByProvider.all(
          provider,
          JSON.stringify(statuses),
        ) as unknown as SessionRow[]
      ).map(toSession),
    pendingRemovals: (provider) =>
      (
        selectPendingRemovals.all(
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
