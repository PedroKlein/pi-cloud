import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "./store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("keeps sessions from a database that stored a working directory", () => {
  const path = join(root, "server.db");
  const old = new DatabaseSync(path);

  old.exec(`
    create table sessions (
      id text primary key,
      provider text not null,
      cwd text not null,
      status text not null,
      generation integer not null,
      created_at text not null,
      interrupted_at text,
      error text
    );
    insert into sessions values ('s1', 'local', '/home/me/repo', 'idle', 2, '2026-10-19T00:00:00.000Z', null, null);
  `);

  old.close();

  const store = openStore(path);
  const session = store.get("s1");
  store.close();

  expect(session).toEqual({
    id: "s1",
    provider: "local",
    workspace: { kind: "folder", path: "/home/me/repo" },
    model: null,
    status: "idle",
    generation: 2,
    createdAt: "2026-10-19T00:00:00.000Z",
    interruptedAt: null,
    error: null,
    archivedAt: null,
    workspaceRemoval: null,
  });
});

test("opens a migrated database again", () => {
  const path = join(root, "server.db");
  openStore(path).close();

  const store = openStore(path);

  store.insert({
    id: "s1",
    provider: "vm",
    workspace: { kind: "clone", repository: "r", branch: "b" },
    model: { provider: "openai", id: "gpt-5-mini" },
    status: "queued",
    generation: 0,
    createdAt: "2026-10-20T00:00:00.000Z",
    interruptedAt: null,
    error: null,
    archivedAt: null,
    workspaceRemoval: null,
  });

  expect(store.get("s1")).toMatchObject({
    workspace: { kind: "clone", repository: "r", branch: "b" },
    model: { provider: "openai", id: "gpt-5-mini" },
  });

  store.close();
});
