import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProfileFolders } from "@pipoca/profiles";
import type { StoredSession } from "@pipoca/sessions";
import { openStore } from "./store";

let root: string;
let defaultProfile: string;

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
  const environments = store.environments();
  const defaultProfileId = store.defaultProfileId("local");
  store.close();

  expect(defaultProfileId).toBe("default");

  expect(environments).toMatchObject([
    { name: "local", provider: "local", ownerId: "local" },
  ]);

  expect(session).toEqual({
    id: "s1",
    environmentId: environments[0]?.id ?? "",
    ownerId: "local",
    owner: null,
    provider: "local",
    runner: "local",
    profileId: defaultProfileId,
    workspace: { kind: "folder", path: "/home/me/repo" },
    model: null,
    thinking: null,
    systemPrompt: null,
    firstMessage: null,
    title: null,
    status: "idle",
    generation: 2,
    createdAt: "2026-10-19T00:00:00.000Z",
    interruptedAt: null,
    error: null,
    archivedAt: null,
    workspaceRemoval: null,
    workspaceKeptReason: null,
  });
});

test("opens a migrated database again", () => {
  const path = join(root, "server.db");
  openStore(path).close();

  const store = openStore(path);
  store.ensureEnvironment("vm");
  store.ensureEnvironment("vm");
  const [environment] = store.environments();

  store.insert({
    id: "s1",
    environmentId: environment?.id ?? "",
    ownerId: "local",
    owner: null,
    provider: "vm",
    runner: null,
    profileId: store.defaultProfileId("local"),
    workspace: { kind: "clone", repository: "r", branch: "b" },
    model: { provider: "openai", id: "gpt-5-mini" },
    thinking: "high",
    systemPrompt: null,
    firstMessage: null,
    title: null,
    status: "queued",
    generation: 0,
    createdAt: "2026-10-20T00:00:00.000Z",
    interruptedAt: null,
    error: null,
    archivedAt: null,
    workspaceRemoval: null,
    workspaceKeptReason: null,
  });

  expect(store.environments()).toHaveLength(1);

  expect(store.get("s1")).toMatchObject({
    provider: "vm",
    thinking: "high",
    workspace: { kind: "clone", repository: "r", branch: "b" },
    model: { provider: "openai", id: "gpt-5-mini" },
  });

  store.close();
});

test("lists the Sessions one owner holds and keeps an owner once given", () => {
  const store = openStore(":memory:");
  defaultProfile = store.defaultProfileId("local");
  store.ensureEnvironment("vm");
  const [environment] = store.environments();
  const id = environment?.id ?? "";
  const project = { plugin: "projects", key: "p1" };

  store.insert(
    sessionIn(id, "vm", {
      id: "owned",
      createdAt: "2026-10-24T00:00:01.000Z",
      owner: project,
    }),
  );

  store.insert(
    sessionIn(id, "vm", { id: "old", createdAt: "2026-10-24T00:00:02.000Z" }),
  );

  store.insert(
    sessionIn(id, "vm", {
      id: "other",
      createdAt: "2026-10-24T00:00:03.000Z",
      owner: { plugin: "projects", key: "p2" },
    }),
  );

  store.setOwner("old", project);

  expect(
    store.list({ includeArchived: false, owner: project }).map((s) => s.id),
  ).toEqual(["old", "owned"]);

  expect(store.get("owned")?.owner).toEqual(project);
  expect(store.list({ includeArchived: false })).toHaveLength(3);

  store.close();
});

function sessionIn(
  environmentId: string,
  provider: string,
  fields: Partial<StoredSession> & Pick<StoredSession, "id" | "createdAt">,
): StoredSession {
  return {
    environmentId,
    ownerId: "local",
    owner: null,
    provider,
    runner: null,
    profileId: defaultProfile,
    workspace: { kind: "clone", repository: "r", branch: fields.id },
    model: null,
    thinking: null,
    systemPrompt: null,
    firstMessage: null,
    title: null,
    status: "stopped",
    generation: 1,
    interruptedAt: null,
    error: null,
    archivedAt: null,
    workspaceRemoval: null,
    workspaceKeptReason: null,
    ...fields,
  };
}

test("lists sessions newest first and leaves archived ones out unless asked", () => {
  const store = openStore(join(root, "server.db"));
  defaultProfile = store.defaultProfileId("local");
  store.ensureEnvironment("vm");
  const vm = store.environments()[0]?.id ?? "";

  for (const session of [
    sessionIn(vm, "vm", {
      id: "old",
      createdAt: "2026-10-01T00:00:00.000Z",
      status: "idle",
    }),
    sessionIn(vm, "vm", {
      id: "archived",
      createdAt: "2026-10-02T00:00:00.000Z",
      archivedAt: "2026-10-03T00:00:00.000Z",
    }),
    sessionIn(vm, "vm", {
      id: "new",
      createdAt: "2026-10-04T00:00:00.000Z",
      status: "queued",
    }),
  ]) {
    store.insert(session);
  }

  const ids = (includeArchived: boolean): string[] =>
    store.list({ includeArchived }).map(({ id }) => id);

  expect(ids(false)).toEqual(["new", "old"]);
  expect(ids(true)).toEqual(["new", "archived", "old"]);

  store.close();
});

test("lists a provider's stopped sessions whose workspace is waiting to be removed, oldest first", () => {
  const store = openStore(join(root, "server.db"));
  defaultProfile = store.defaultProfileId("local");
  store.ensureEnvironment("vm");
  store.ensureEnvironment("laptop");

  const environments = new Map(
    store.environments().map(({ provider, id }) => [provider, id]),
  );

  const vm = environments.get("vm") ?? "";
  const archivedAt = "2026-10-10T00:00:00.000Z";

  const forced = sessionIn(vm, "vm", {
    id: "forced",
    runner: "vm",
    createdAt: "2026-10-03T00:00:00.000Z",
    archivedAt,
    workspaceRemoval: "forced",
  });

  for (const session of [
    forced,
    sessionIn(vm, "vm", {
      id: "pending",
      createdAt: "2026-10-01T00:00:00.000Z",
      archivedAt,
      workspaceRemoval: "pending",
    }),
    sessionIn(vm, "vm", {
      id: "removed",
      createdAt: "2026-10-02T00:00:00.000Z",
      archivedAt,
      workspaceRemoval: "removed",
    }),
    sessionIn(vm, "vm", {
      id: "kept",
      createdAt: "2026-10-04T00:00:00.000Z",
      archivedAt,
      workspaceRemoval: "kept",
    }),
    sessionIn(vm, "vm", {
      id: "nothing to remove",
      createdAt: "2026-10-05T00:00:00.000Z",
      archivedAt,
    }),
    sessionIn(vm, "vm", {
      id: "running",
      createdAt: "2026-10-06T00:00:00.000Z",
      status: "running",
      workspaceRemoval: "pending",
    }),
    sessionIn(vm, "vm", {
      id: "on another runner",
      runner: "vm-2",
      createdAt: "2026-10-06T00:00:00.000Z",
      archivedAt,
      workspaceRemoval: "pending",
    }),
    sessionIn(environments.get("laptop") ?? "", "laptop", {
      id: "elsewhere",
      createdAt: "2026-10-07T00:00:00.000Z",
      archivedAt,
      workspaceRemoval: "pending",
    }),
  ]) {
    store.insert(session);
  }

  const removals = store.pendingRemovals("vm", "vm");

  expect(removals.map(({ id }) => id)).toEqual(["pending", "forced"]);
  expect(removals[1]).toEqual(forced);

  expect(store.pendingRemovals("laptop", "laptop").map(({ id }) => id)).toEqual(
    ["elsewhere"],
  );

  expect(store.pendingRemovals("vm", "vm-2").map(({ id }) => id)).toEqual([
    "pending",
    "on another runner",
  ]);

  store.close();
});

test("gives Sessions from before Profiles the default Profile, from before pools their runner, and old Environments no settings", () => {
  const path = join(root, "server.db");
  const old = new DatabaseSync(path);

  old.exec(`
    create table environments (
      id text primary key,
      name text not null,
      provider text not null unique,
      owner_id text not null,
      created_at text not null
    );
    create table sessions (
      id text primary key,
      environment_id text not null references environments (id),
      owner_id text not null,
      owner_plugin text,
      owner_key text,
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
    insert into environments values ('e1', 'vm', 'vm', 'local', '2026-10-23T00:00:00.000Z');
    insert into sessions (id, environment_id, owner_id, workspace, status, generation, created_at)
      values ('s1', 'e1', 'local', '{"kind":"folder","path":"/w"}', 'idle', 1, '2026-10-23T00:00:00.000Z');
    insert into sessions (id, environment_id, owner_id, workspace, status, generation, created_at)
      values ('s2', 'e1', 'local', '{"kind":"folder","path":"/w"}', 'queued', 0, '2026-10-23T00:00:00.000Z');
  `);

  old.close();

  const store = openStore(path);
  const [ran, queued] = [store.get("s1"), store.get("s2")];
  const defaultProfileId = store.defaultProfileId("local");
  const [environment] = store.environments();
  store.close();

  expect(environment).toMatchObject({
    setupScript: "",
    variables: {},
    secrets: {},
  });

  expect(ran?.profileId).toBe(defaultProfileId);
  expect(ran?.runner).toBe("vm");
  expect(queued?.runner).toBeNull();
});

function rawSecrets(path: string): string[] {
  const db = new DatabaseSync(path);

  const rows = db.prepare("select secrets from environments").all() as {
    secrets: string;
  }[];

  db.close();

  return rows.map(({ secrets }) => secrets);
}

test("stores Environment secrets encrypted and reads them back after a restart", () => {
  const path = join(root, "server.db");
  const store = openStore(path);
  store.ensureEnvironment("vm");
  const [environment] = store.environments();

  if (environment === undefined) {
    throw new Error("no Environment");
  }

  store.updateEnvironment({ ...environment, secrets: { GH_TOKEN: "ghp_1" } });
  store.close();

  expect(rawSecrets(path).join()).not.toContain("ghp_1");

  const again = openStore(path);

  expect(again.environments()[0]?.secrets).toEqual({ GH_TOKEN: "ghp_1" });

  again.close();
});

test("encrypts secrets a database stored before they were encrypted", () => {
  const path = join(root, "server.db");
  const store = openStore(path);
  store.ensureEnvironment("vm");
  store.close();

  const old = new DatabaseSync(path);
  old.exec(`update environments set secrets = '{"GH_TOKEN":"ghp_1"}'`);
  old.close();

  const again = openStore(path);
  const [environment] = again.environments();
  again.close();

  expect(environment?.secrets).toEqual({ GH_TOKEN: "ghp_1" });
  expect(rawSecrets(path).join()).not.toContain("ghp_1");
});

test("refuses to open a database's secrets with another key", () => {
  const path = join(root, "server.db");
  const store = openStore(path, randomBytes(32));
  store.ensureEnvironment("vm");
  const [environment] = store.environments();

  if (environment === undefined) {
    throw new Error("no Environment");
  }

  store.updateEnvironment({ ...environment, secrets: { GH_TOKEN: "ghp_1" } });
  store.close();

  expect(() => openStore(path, randomBytes(32))).toThrow(
    "the secret key doesn't open this database's secrets",
  );
});

test("refuses a secret key of the wrong length", () => {
  expect(() => openStore(":memory:", randomBytes(16))).toThrow(
    "the secret key must be 32 bytes",
  );
});

test("seals a plugin's secrets so only that plugin opens them, for that row", () => {
  const store = openStore(":memory:");
  const sealed = store.plugin("oidc").seal("s3cret", "provider-1");

  expect(sealed).not.toContain("s3cret");
  expect(store.plugin("oidc").open(sealed, "provider-1")).toBe("s3cret");
  expect(() => store.plugin("other").open(sealed, "provider-1")).toThrow();
  expect(() => store.plugin("oidc").open(sealed, "provider-2")).toThrow();

  store.close();
});

test("moves Profiles from the database to folders and points at them", () => {
  const path = join(root, "server.db");
  openStore(path, undefined, folders()).close();

  const old = new DatabaseSync(path);

  const empty = JSON.stringify({
    packages: [],
    agentsMd: "",
    systemMd: "",
    appendSystemMd: "",
    mcpServers: {},
    settings: {},
  });

  const work = JSON.stringify({
    ...(JSON.parse(empty) as object),
    packages: ["npm:pi-goal-x"],
    agentsMd: "Be brief.",
    settings: { defaultThinkingLevel: "high" },
  });

  old.exec(`
    create table profiles (
      id text primary key,
      owner_id text not null,
      name text not null,
      content text not null,
      created_at text not null
    );
    drop table profile_defaults;
    create table profile_defaults (
      owner_id text primary key,
      profile_id text not null references profiles (id)
    );
    insert into environments (id, name, provider, owner_id, created_at)
      values ('e1', 'vm', 'vm', 'local', '2026-10-24T00:00:00.000Z');
    create table projects_projects (id text primary key, profile_id text);
    insert into projects_projects values ('p1', 'uuid-work');
  `);

  const insertProfile = old.prepare(
    "insert into profiles values (?, 'local', ?, ?, '2026-10-24T00:00:00.000Z')",
  );

  insertProfile.run("uuid-default", "Default", empty);
  insertProfile.run("uuid-work", "Work", work);

  const insertSession = old.prepare(
    `insert into sessions (id, environment_id, owner_id, runner, profile_id, workspace, status, generation, created_at)
      values (?, 'e1', 'local', 'vm', ?, '{"kind":"folder","path":"/w"}', 'idle', 1, '2026-10-24T00:00:00.000Z')`,
  );

  insertSession.run("s1", "uuid-default");
  insertSession.run("s2", "uuid-work");

  old.exec(
    "insert into profile_defaults (owner_id, profile_id) values ('local', 'uuid-work')",
  );

  old.close();

  const profiles = folders();
  const store = openStore(path, undefined, profiles);
  const sessions = [store.get("s1"), store.get("s2")];
  const defaultProfileId = store.defaultProfileId("local");
  store.close();

  expect(sessions.map((session) => session?.profileId)).toEqual([
    "default",
    "work",
  ]);

  expect(defaultProfileId).toBe("work");
  expect(profiles.ids()).toEqual(["default", "work"]);

  expect(profiles.read("work")).toMatchObject({
    name: "Work",
    ownerId: "local",
    packages: ["npm:pi-goal-x"],
    agentsMd: "Be brief.",
    settings: { defaultThinkingLevel: "high" },
  });

  const migrated = new DatabaseSync(path);

  const tables = migrated
    .prepare("select name from sqlite_master where name = 'profiles'")
    .all();

  const project = migrated
    .prepare("select profile_id from projects_projects")
    .get();

  migrated.close();

  expect(tables).toEqual([]);
  expect(project).toEqual({ profile_id: "work" });
});

function folders(): ProfileFolders {
  return new ProfileFolders(join(root, "profiles"), () => undefined);
}
