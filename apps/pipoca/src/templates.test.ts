import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Assignment,
  type Environment,
  type EnvironmentTemplate,
  type Joined,
  protocolVersion,
  versionHeader,
} from "@pipoca/protocol";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";

let root: string;
let server: ReturnType<typeof serve>;
let pedro: () => Promise<string>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "templates-"));
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

function start(): void {
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
}

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

const pods = {
  name: "Cluster pods",
  setupScript: "apt-get install -y ripgrep",
  variables: { REGION: "eu", TEAM: "core" },
};

test("only admins change templates, and everyone reads them", async () => {
  start();
  const anas = await ana();

  expect((await api("/api/templates", anas, pods)).status).toBe(403);

  const made = await json<EnvironmentTemplate>(
    api("/api/templates", await pedro(), pods),
  );

  expect(made).toEqual({
    id: "cluster-pods",
    isolation: "process",
    image: null,
    ...pods,
  });

  expect(
    (await api(`/api/templates/${made.id}`, anas, { name: "x" }, "PATCH"))
      .status,
  ).toBe(403);

  expect(
    (
      await api(
        `/api/templates/${made.id}`,
        await pedro(),
        { name: "Pods" },
        "PATCH",
      )
    ).status,
  ).toBe(200);

  expect(await json(api("/api/templates", anas))).toEqual([
    { ...made, name: "Pods" },
  ]);

  expect(
    (await api("/api/templates", await pedro(), { ...pods, secrets: {} }))
      .status,
  ).toBe(400);
});

test("runs a person's Environment as its template says, with their own variables on top", async () => {
  start();
  const anas = await ana();

  const template = await json<EnvironmentTemplate>(
    api("/api/templates", await pedro(), pods),
  );

  const { environment, key } = await json<{
    environment: Environment;
    key: string;
  }>(api("/api/environments", anas, { name: "mine", template: template.id }));

  expect(environment).toMatchObject({
    templateId: template.id,
    setupScript: pods.setupScript,
  });

  await api(
    `/api/environments/${environment.id}`,
    anas,
    { variables: { TEAM: "ana" }, secrets: { TOKEN: "s3cret" } },
    "PATCH",
  );

  expect(
    (
      await api(
        `/api/environments/${environment.id}`,
        anas,
        { setupScript: "true" },
        "PATCH",
      )
    ).status,
  ).toBe(409);

  await api("/api/sessions", anas, {
    environment: environment.id,
    workspace: { kind: "folder", path: root },
  });

  const { token } = await json<Joined>(
    fetch(new URL("/agent/join", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ name: "laptop" }),
    }),
  );

  const { start: assignments } = await json<{ start: Assignment[] }>(
    fetch(new URL("/agent/work", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ running: [], folders: [root], models: [] }),
    }),
  );

  expect(assignments[0]?.environment).toEqual({
    isolation: "process",
    image: null,
    setupScript: pods.setupScript,
    variables: { REGION: "eu", TEAM: "ana", TOKEN: "s3cret" },
  });

  expect(
    (
      await api("/api/environments", anas, {
        name: "other",
        template: "nowhere",
      })
    ).status,
  ).toBe(400);
});

test("reads templates an admin wrote into pipoca.json", async () => {
  await mkdir(join(root, "config"), { recursive: true });

  await writeFile(
    join(root, "config", "pipoca.json"),
    JSON.stringify({
      templates: [
        { id: "vm", name: "VM", image: "debian:12", isolation: "container" },
        { name: "no id" },
      ],
    }),
  );

  start();

  expect(await json(api("/api/templates", await pedro()))).toEqual([
    {
      id: "vm",
      name: "VM",
      isolation: "container",
      image: "debian:12",
      setupScript: "",
      variables: {},
    },
  ]);
});
