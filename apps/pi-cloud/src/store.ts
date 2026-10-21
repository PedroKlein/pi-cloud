import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelRef, SessionStatus, Workspace } from "@pi-cloud/protocol";
import type { SessionStore, StoredSession } from "@pi-cloud/sessions";

interface SessionRow {
  id: string;
  provider: string;
  workspace: string;
  model: string | null;
  status: SessionStatus;
  generation: number;
  created_at: string;
  interrupted_at: string | null;
  error: string | null;
}

const schema = `
create table if not exists sessions (
  id text primary key,
  provider text not null,
  workspace text not null,
  model text,
  status text not null,
  generation integer not null,
  created_at text not null,
  interrupted_at text,
  error text
);
create table if not exists transcript (
  session_id text not null references sessions (id),
  line integer not null,
  entry text not null,
  primary key (session_id, line)
);
`;

// Databases from before Sessions had a workspace stored a folder path in cwd.
function migrate(db: DatabaseSync): void {
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

  if (
    columns.length > 0 &&
    !columns.some((column) => column.name === "model")
  ) {
    db.exec("alter table sessions add column model text");
  }

  db.exec(schema);
}

export function openStore(path: string): SessionStore & {
  check: () => void;
  close: () => void;
} {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal");
  migrate(db);

  const toSession = (row: SessionRow): StoredSession => ({
    id: row.id,
    provider: row.provider,
    workspace: JSON.parse(row.workspace) as Workspace,
    model: row.model === null ? null : (JSON.parse(row.model) as ModelRef),
    status: row.status,
    generation: row.generation,
    createdAt: row.created_at,
    interruptedAt: row.interrupted_at,
    error: row.error,
  });

  const insert = db.prepare(
    "insert into sessions (id, provider, workspace, model, status, generation, created_at, interrupted_at, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const update = db.prepare(
    "update sessions set status = ?, generation = ?, interrupted_at = ?, error = ? where id = ?",
  );

  const check = db.prepare("select 1 from sessions limit 1");
  const get = db.prepare("select * from sessions where id = ?");
  const list = db.prepare("select * from sessions order by created_at desc");

  const byProvider = db.prepare(
    "select * from sessions where provider = ? and status in (select value from json_each(?)) order by created_at",
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
        s.provider,
        JSON.stringify(s.workspace),
        s.model && JSON.stringify(s.model),
        s.status,
        s.generation,
        s.createdAt,
        s.interruptedAt,
        s.error,
      );
    },
    update: (s) => {
      update.run(s.status, s.generation, s.interruptedAt, s.error, s.id);
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
    close: () => {
      db.close();
    },
  };
}
