import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Environment, Joined, Session } from "@pipoca/protocol";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";

let root: string;
let server: ReturnType<typeof serve>;
let pedro: () => Promise<string>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "people-"));

  const logs: string[] = [];

  server = serve({
    port: 0,
    database: join(root, "server.db"),
    configDir: join(root, "config"),
    sessions: { pollWaitMs: 0 },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  pedro = firstUser(server, logs);
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

async function api(
  path: string,
  cookie: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method,
    headers: {
      cookie,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function json<T>(response: Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

// Signs in a second user, who isn't an admin, and returns their cookie.
async function ana(): Promise<string> {
  await pedro();

  const db = new DatabaseSync(join(root, "server.db"));

  db.prepare(
    "insert into users (id, name, password_hash, created_at, admin) values (?, 'ana', ?, ?, 0)",
  ).run(
    randomUUID(),
    await Bun.password.hash("battery staple"),
    new Date().toISOString(),
  );

  db.close();

  const response = await fetch(new URL("/api/auth/login", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "ana", password: "battery staple" }),
  });

  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function environment(cookie: string, name: string): Promise<string> {
  const created = await json<{ environment: Environment }>(
    api("/api/environments", cookie, { name }),
  );

  return created.environment.id;
}

async function session(
  cookie: string,
  environmentId?: string,
): Promise<Session> {
  return json(
    api("/api/sessions", cookie, {
      ...(environmentId !== undefined && { environment: environmentId }),
      workspace: { kind: "folder", path: root },
      firstMessage: "hello",
    }),
  );
}

const names = (environments: readonly Environment[]): string[] =>
  environments.map(({ name }) => name);

test("a person sees, changes and starts Sessions only in their own Environments", async () => {
  const anas = await ana();
  const mac = await environment(await pedro(), "mac");
  const laptop = await environment(anas, "laptop");

  expect(names(await json(api("/api/environments", await pedro())))).toEqual([
    "mac",
  ]);

  expect(names(await json(api("/api/environments", anas)))).toEqual(["laptop"]);

  expect(
    (await api(`/api/environments/${mac}`, anas, { name: "x" }, "PATCH"))
      .status,
  ).toBe(404);

  expect((await api(`/api/environments/${mac}/key`, anas, {})).status).toBe(
    404,
  );

  expect(
    (
      await api("/api/sessions", anas, {
        environment: mac,
        workspace: { kind: "folder", path: root },
      })
    ).status,
  ).toBe(400);

  expect((await session(anas)).environmentId).toBe(laptop);
});

test("an Environment a runner makes with a join key is the key maker's", async () => {
  const anas = await ana();

  const { key } = await json<{ key: string }>(api("/api/join-key", anas, {}));

  await json<Joined>(
    fetch(new URL("/agent/join", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "pipoca-protocol": "4",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ name: "vm" }),
    }),
  );

  expect(names(await json(api("/api/environments", anas)))).toEqual(["vm"]);
  expect(await json(api("/api/environments", await pedro()))).toEqual([]);
});

test("a person sees and drives only their own Sessions", async () => {
  const anas = await ana();
  await environment(await pedro(), "mac");
  await environment(anas, "laptop");

  const his = await session(await pedro());
  const hers = await session(anas);

  const ids = (sessions: readonly Session[]): string[] =>
    sessions.map(({ id }) => id);

  expect(ids(await json(api("/api/sessions", anas)))).toEqual([hers.id]);

  expect(ids(await json(api("/api/sessions?owner=all", anas)))).toEqual([
    hers.id,
  ]);

  const refused = [
    api(`/api/sessions/${his.id}`, anas),
    api(`/api/sessions/${his.id}/events`, anas),
    api(`/api/sessions/${his.id}/commands`, anas, { type: "abort" }),
    api(`/api/sessions/${his.id}/fork`, anas, {}),
    api(`/api/sessions/${his.id}/archive`, anas, {}),
    api(`/api/sessions/${his.id}/terminal`, anas),
  ];

  for (const response of await Promise.all(refused)) {
    expect(response.status).toBe(404);
  }
});

test("an admin sees everyone's Environments and Sessions as an outline and can stop them", async () => {
  const anas = await ana();
  await environment(await pedro(), "mac");
  const laptop = await environment(anas, "laptop");

  await api(
    `/api/environments/${laptop}`,
    anas,
    { variables: { TEAM: "blue" } },
    "PATCH",
  );

  const hers = await session(anas);

  const everyone = await json<Environment[]>(
    api("/api/environments?people=all", await pedro()),
  );

  expect(names(everyone)).toEqual(["mac", "laptop"]);
  expect(everyone[1]?.variables).toEqual({});

  const sessions = await json<Session[]>(
    api("/api/sessions?people=all", await pedro()),
  );

  expect(sessions.map(({ id }) => id)).toContain(hers.id);

  const outline = await json<Session>(
    api(`/api/sessions/${hers.id}`, await pedro()),
  );

  expect(outline.id).toBe(hers.id);
  expect(outline.firstMessage).toBeNull();

  expect(
    (await api(`/api/sessions/${hers.id}/events`, await pedro())).status,
  ).toBe(404);

  expect(
    (
      await api(`/api/sessions/${hers.id}/commands`, await pedro(), {
        type: "message",
        text: "hi",
      })
    ).status,
  ).toBe(404);

  // Reaches the Session, which isn't running yet.
  expect(
    (
      await api(`/api/sessions/${hers.id}/commands`, await pedro(), {
        type: "abort",
      })
    ).status,
  ).toBe(409);

  expect(
    (await api(`/api/sessions/${hers.id}/archive`, await pedro(), {})).status,
  ).toBe(200);

  expect(names(await json(api("/api/environments?people=all", anas)))).toEqual([
    "laptop",
  ]);
});

test("only an admin lists everyone", async () => {
  const anas = await ana();

  const everyone = await json<{ name: string; admin: boolean }[]>(
    api("/api/people", await pedro()),
  );

  expect(everyone.map(({ name, admin }) => [name, admin])).toEqual([
    ["pedro", true],
    ["ana", false],
  ]);

  expect((await api("/api/people", anas)).status).toBe(403);
});

test("a person lists only the meta-sessions they started", async () => {
  const anas = await ana();
  await environment(await pedro(), "mac");

  const started = await api("/api/plugins/meta/sessions", await pedro(), {
    text: "what can you do?",
  });

  expect(started.status).toBe(201);

  expect(
    await json<Session[]>(api("/api/plugins/meta/sessions", await pedro())),
  ).toHaveLength(1);

  expect(await json(api("/api/plugins/meta/sessions", anas))).toEqual([]);
});
