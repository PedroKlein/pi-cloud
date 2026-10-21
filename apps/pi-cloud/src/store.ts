import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  ModelRef,
  SessionStatus,
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

const environments = `
create table if not exists environments (
  id text primary key,
  name text not null,
  provider text not null unique,
  owner_id text not null,
  created_at text not null
);
`;

const schema = `
create table if not exists sessions (
  id text primary key,
  environment_id text not null references environments (id),
  owner_id text not null,
  workspace text not null,
  model text,
  system_prompt text,
  first_message text,
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
  db.exec(environments);

  const columns = db
    .prepare("select name from pragma_table_info('sessions')")
    .all() as { name: string }[];

  if (columns.some((column) => column.name === "cwd")) {
    db.exec(`
      begin;
      alter table sessions rename column cwd to workspace;
      update sessions set workspace = json_object('kind', 'folder', 'path', workspace);
      commit;
    `);
  }

  for (const column of [
    "model",
    "archived_at",
    "workspace_removal",
    "system_prompt",
    "first_message",
  ]) {
    if (columns.length > 0 && !columns.some(({ name }) => name === column)) {
      db.exec(`alter table sessions add column ${column} text`);
    }
  }

  if (columns.some(({ name }) => name === "provider")) {
    migrateToEnvironments(db);
  }

  db.exec(schema);
}

function migrateToEnvironments(db: DatabaseSync): void {
  const providers = db
    .prepare("select distinct provider from sessions")
    .all() as { provider: string }[];

  db.exec("begin");
  try {
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

    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function insertEnvironment(db: DatabaseSync, provider: string): void {
  db.prepare(
    "insert into environments (id, name, provider, owner_id, created_at) values (?, ?, ?, ?, ?) on conflict (provider) do nothing",
  ).run(randomUUID(), provider, provider, owner, new Date().toISOString());
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
    firstMessage: row.first_message,
    status: row.status,
    generation: row.generation,
    createdAt: row.created_at,
    interruptedAt: row.interrupted_at,
    error: row.error,
    archivedAt: row.archived_at,
    workspaceRemoval: row.workspace_removal,
  });

  const insert = db.prepare(
    "insert into sessions (id, environment_id, owner_id, workspace, model, system_prompt, first_message, status, generation, created_at, interrupted_at, error, archived_at, workspace_removal) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const update = db.prepare(
    "update sessions set workspace = ?, status = ?, generation = ?, interrupted_at = ?, error = ?, archived_at = ?, workspace_removal = ? where id = ?",
  );

  const check = db.prepare("select 1 from sessions limit 1");

  const withProvider =
    "select sessions.*, environments.provider from sessions join environments on environments.id = sessions.environment_id";

  const get = db.prepare(`${withProvider} where sessions.id = ?`);
  const list = db.prepare(`${withProvider} order by sessions.created_at desc`);

  const byProvider = db.prepare(
    `${withProvider} where environments.provider = ? and status in (select value from json_each(?)) order by sessions.created_at`,
  );

  const toEnvironment = (row: EnvironmentRow): StoredEnvironment => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    ownerId: row.owner_id,
    createdAt: row.created_at,
  });

  const environmentList = db.prepare(
    "select * from environments order by created_at, name",
  );

  const length = db.prepare(
    "select count(*) as n from transcript where session_id = ?",
  );

  const appendLine = db.prepare(
    "insert into transcript (session_id, line, entry) values (?, ?, ?)",
  );

  const transcript = db.prepare(
    "select entry from transcript where session_id = ? and line >= ? order by line",
  );

  return {
    insert: (s) => {
      insert.run(
        s.id,
        s.environmentId,
        s.ownerId,
        JSON.stringify(s.workspace),
        s.model && JSON.stringify(s.model),
        s.systemPrompt,
        s.firstMessage,
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
      update.run(
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
      const row = get.get(id) as SessionRow | undefined;

      return row && toSession(row);
    },
    list: () => (list.all() as unknown as SessionRow[]).map(toSession),
    byProvider: (provider, statuses) =>
      (
        byProvider.all(
          provider,
          JSON.stringify(statuses),
        ) as unknown as SessionRow[]
      ).map(toSession),
    ensureEnvironment: (provider) => {
      insertEnvironment(db, provider);
    },
    environments: () =>
      (environmentList.all() as unknown as EnvironmentRow[]).map(toEnvironment),
    transcriptLength: (id) => (length.get(id) as { n: number }).n,
    appendTranscript: (id, start, lines) => {
      db.exec("begin");
      try {
        lines.forEach((entry, i) => appendLine.run(id, start + i, entry));
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
    transcript: (id, from) =>
      (transcript.all(id, from) as { entry: string }[]).map((r) => r.entry),
    check: () => {
      check.get();
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
    all: (sql, ...params) =>
      db.prepare(sql).all(...(params as SQLInputValue[])),
    run: (sql, ...params) => {
      db.prepare(sql).run(...(params as SQLInputValue[]));
    },
  };
}
