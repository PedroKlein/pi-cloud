import { afterEach, beforeEach, expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Assignment,
  type Attempt,
  type Environment,
  type Session,
  type WorkspaceRequest,
  protocolVersion,
  versionHeader,
  type Work,
  type WorkPoll,
} from "@pi-cloud/protocol";
import type { ServerPluginContext } from "@pi-cloud/plugins";
import { serve } from "./serve";
import { runnerCredentials } from "./testdata/runners";
import { firstUser } from "./testdata/sign-in";

const leaseMs = 200;

let server: ReturnType<typeof serve>;
let signedIn: () => Promise<string>;
let runners: ReturnType<typeof runnerCredentials>;
let logged: string[];

let machines: ServerPluginContext["environments"] | undefined;

function startServer({ pollWaitMs = 0, offlineAfterMs = 30_000 } = {}): void {
  logged = [];

  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs, offlineAfterMs, leaseMs },
    plugins: [
      {
        name: "machines",
        register: ({ environments }) => {
          machines = environments;
        },
      },
    ],
    log: (message, fields) => {
      logged.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logged);
  runners = runnerCredentials(server, signedIn);
}

beforeEach(() => {
  startServer();
});

afterEach(async () => {
  await server.stop();
});

async function json<T>(response: Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

async function poll(
  runner: string,
  {
    folders = [],
    running = [],
    capacity,
    environment = "laptops",
  }: {
    readonly environment?: string;
    readonly folders?: readonly string[];
    readonly running?: readonly Attempt[];
    readonly capacity?: number;
  } = {},
): Promise<{
  readonly start: readonly Assignment[];
  readonly unload: readonly Attempt[];
}> {
  const body: WorkPoll = {
    running,
    folders,
    models: [],
    ...(capacity !== undefined && { capacity }),
  };

  return json(
    fetch(new URL("/agent/work", server.url), {
      method: "POST",
      headers: {
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${await runners.token(runner, environment)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function claimed(
  runner: string,
  options?: Parameters<typeof poll>[1],
): Promise<readonly Assignment[]> {
  return (await poll(runner, options)).start;
}

async function startSession(
  workspace: string | WorkspaceRequest,
): Promise<string> {
  const session = await json<{ readonly id: string }>(
    fetch(new URL("/api/sessions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await signedIn() },
      body: JSON.stringify({
        workspace:
          typeof workspace === "string"
            ? { kind: "folder", path: workspace }
            : workspace,
      }),
    }),
  );

  return session.id;
}

async function environmentId(provider = "laptops"): Promise<string> {
  const listed = await json<Environment[]>(
    fetch(new URL("/api/environments", server.url), {
      headers: { cookie: await signedIn() },
    }),
  );

  return listed.find((each) => each.provider === provider)?.id ?? "";
}

async function unplaced(): Promise<readonly string[]> {
  const id = await environmentId();

  return machines?.unplaced(id).map((session) => session.id) ?? [];
}

function ids(assignments: readonly Assignment[]): readonly string[] {
  return assignments.map(({ sessionId }) => sessionId);
}

test("lists every runner that joined an Environment's pool", async () => {
  await claimed("mac-1", { folders: ["/srv/a"], capacity: 2 });
  await claimed("mac-2", { folders: ["/srv/b"] });

  const environments = await json<Environment[]>(
    fetch(new URL("/api/environments", server.url), {
      headers: { cookie: await signedIn() },
    }),
  );

  expect(environments).toMatchObject([
    {
      provider: "laptops",
      online: true,
      folders: ["/srv/a", "/srv/b"],
      runners: [
        { name: "mac-1", online: true, capacity: 2, running: 0 },
        { name: "mac-2", online: true, capacity: null, running: 0 },
      ],
    },
  ]);
});

test("places a folder Session on the runner that lists the folder", async () => {
  await claimed("mac-1", { folders: ["/srv/a"] });
  await claimed("mac-2", { folders: ["/srv/b"] });

  const id = await startSession("/srv/b/app");

  const onFirst = await claimed("mac-1", { folders: ["/srv/a"] });
  const onSecond = await claimed("mac-2", { folders: ["/srv/b"] });

  expect(onFirst).toEqual([]);
  expect(ids(onSecond)).toEqual([id]);
});

test("gives a runner no more Sessions than its capacity has room for", async () => {
  await claimed("mac-1", { capacity: 1 });

  const first = await startSession("/srv/a");
  const second = await startSession("/srv/b");

  const [assigned] = await claimed("mac-1", { capacity: 1 });
  if (!assigned) {
    throw new Error("no session was assigned");
  }

  const whileFull = await claimed("mac-1", {
    capacity: 1,
    running: [
      { sessionId: assigned.sessionId, generation: assigned.generation },
    ],
  });

  expect(assigned.sessionId).toBe(first);
  expect(whileFull).toEqual([]);
  expect(ids(await claimed("mac-2"))).toEqual([second]);
});

test("sends an interrupted Session back to the runner it ran on", async () => {
  await claimed("mac-1");

  const id = await startSession("/srv/a");

  expect(ids(await claimed("mac-1"))).toEqual([id]);

  // mac-1 no longer reports the attempt and has no room to take it again.
  await claimed("mac-1", {
    capacity: 1,
    running: [{ sessionId: "other", generation: 1 }],
  });

  expect(await claimed("mac-2")).toEqual([]);
  expect(ids(await claimed("mac-1"))).toEqual([id]);
});

test("moves a Session whose Workspace can be cloned again once its runner's lease lapses", async () => {
  await claimed("mac-1");

  const clone = await startSession({
    kind: "clone",
    repository: "https://example.com/app.git",
  });

  const folder = await startSession("/srv/a");
  const first = await claimed("mac-1");

  await sleep(leaseMs * 1.5);

  const moved = await claimed("mac-2");
  const back = await poll("mac-1", { running: [...first] });

  const session = await json<Session>(
    fetch(new URL(`/api/sessions/${clone}`, server.url), {
      headers: { cookie: await signedIn() },
    }),
  );

  expect(ids(first)).toEqual([clone, folder]);
  expect(moved).toMatchObject([{ sessionId: clone, generation: 2 }]);
  expect(session).toMatchObject({ runner: "mac-2", status: "starting" });
  expect(back.unload).toEqual([{ sessionId: clone, generation: 1 }]);
  expect(back.start).toEqual([]);
});

test("shows a Session offline once its runner joins another Environment", async () => {
  await poll("mac-1");

  const id = await startSession("/srv/a");

  await poll("mac-1");
  await poll("mac-1", { environment: "elsewhere" });

  const session = await json<Session>(
    fetch(new URL(`/api/sessions/${id}`, server.url), {
      headers: { cookie: await signedIn() },
    }),
  );

  expect(session).toMatchObject({ runner: "mac-1", online: false });
});

test("moves a clone Session off a runner that joined another Environment", async () => {
  await claimed("mac-1");

  const clone = await startSession({
    kind: "clone",
    repository: "https://example.com/app.git",
  });

  await claimed("mac-1");
  await claimed("mac-1", { environment: "elsewhere" });

  expect(await claimed("mac-2")).toMatchObject([
    { sessionId: clone, generation: 2 },
  ]);
});

test("gives a runner an Environment's secrets without logging them", async () => {
  await claimed("mac-1");

  const [environment] = await json<Environment[]>(
    fetch(new URL("/api/environments", server.url), {
      headers: { cookie: await signedIn() },
    }),
  );

  await fetch(
    new URL(`/api/environments/${environment?.id ?? ""}`, server.url),
    {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: await signedIn() },
      body: JSON.stringify({ secrets: { TOKEN: "s3cret" } }),
    },
  );

  await startSession("/srv/a");
  const [assignment] = await claimed("mac-1");

  expect(assignment?.environment.variables).toEqual({ TOKEN: "s3cret" });
  expect(logged.some((line) => line.includes("session assigned"))).toBe(true);
  expect(logged.join("\n")).not.toContain("s3cret");
});

test("forks a Session that never started from where it would have, and keeps folder Sessions in their Environment", async () => {
  await claimed("mac-1");
  await claimed("vm-1", { environment: "elsewhere" });

  const environments = await json<Environment[]>(
    fetch(new URL("/api/environments", server.url), {
      headers: { cookie: await signedIn() },
    }),
  );

  const elsewhere = environments.find(
    ({ provider }) => provider === "elsewhere",
  );

  const fork = async (id: string): Promise<Response> =>
    fetch(new URL(`/api/sessions/${id}/fork`, server.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await signedIn() },
      body: JSON.stringify({ environment: elsewhere?.id }),
    });

  const folder = await startSession("/srv/a");

  const clone = await startSession({
    kind: "clone",
    repository: "https://example.com/app.git",
    startPoint: "main",
  });

  const folderFork = await fork(folder);
  const cloneFork = await fork(clone);
  const forked = await json<Session>(Promise.resolve(cloneFork));

  expect(folderFork.status).toBe(409);
  expect(cloneFork.status).toBe(201);

  expect(forked).toMatchObject({
    environmentId: elsewhere?.id,
    workspace: {
      kind: "clone",
      repository: "https://example.com/app.git",
      startPoint: "main",
    },
  });
});

async function asRunner(
  token: string | undefined,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      [versionHeader]: String(protocolVersion),
      "content-type": "application/json",
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

const emptyPoll: WorkPoll = { running: [], folders: [], models: [] };

test("lets a runner join only with its Environment's key", async () => {
  await runners.key("laptops");

  const wrongKey = await fetch(new URL("/agent/join", server.url), {
    method: "POST",
    headers: {
      [versionHeader]: String(protocolVersion),
      authorization: "Bearer pck_guess",
    },
    body: JSON.stringify({ name: "mac-1" }),
  });

  expect(wrongKey.status).toBe(401);

  expect((await asRunner(undefined, "/agent/work", emptyPoll)).status).toBe(
    401,
  );

  expect((await asRunner("pct_guess", "/agent/work", emptyPoll)).status).toBe(
    401,
  );

  const token = await runners.token("mac-1", "laptops");

  expect((await asRunner(token, "/agent/work", emptyPoll)).status).toBe(200);
});

test("lets go of runners that joined with an Environment's earlier key", async () => {
  const token = await runners.token("mac-1", "laptops");
  const id = await startSession("/srv/a");

  const work = await json<Work>(
    asRunner(token, "/agent/work", { ...emptyPoll, folders: ["/srv/a"] }),
  );

  const sessionToken = work.start[0]?.token;

  const [environment] = await json<Environment[]>(
    fetch(new URL("/api/environments", server.url), {
      headers: { cookie: await signedIn() },
    }),
  );

  const replaced = await fetch(
    new URL(`/api/environments/${environment?.id ?? ""}/key`, server.url),
    { method: "POST", headers: { cookie: await signedIn() } },
  );

  expect(replaced.status).toBe(200);
  expect((await asRunner(token, "/agent/work", emptyPoll)).status).toBe(401);

  expect(
    (await asRunner(sessionToken, `/agent/sessions/${id}/transcript`)).status,
  ).toBe(401);
});

test("gives each Session a token that reaches only that Session", async () => {
  const runner = await runners.token("mac-1", "laptops");
  const first = await startSession("/srv/a");
  const second = await startSession("/srv/a");

  const work = await json<Work>(
    asRunner(runner, "/agent/work", { ...emptyPoll, folders: ["/srv/a"] }),
  );

  const token = work.start.find(({ sessionId }) => sessionId === first)?.token;

  const statuses = [
    (await asRunner(token, `/agent/sessions/${first}/transcript`)).status,
    (await asRunner(token, `/agent/sessions/${second}/transcript`)).status,
    (await asRunner(token, "/agent/work", emptyPoll)).status,
  ];

  expect(work.start.map(({ sessionId }) => sessionId).sort()).toEqual(
    [first, second].sort(),
  );

  expect(work.start).toHaveLength(2);

  expect(statuses).toEqual([200, 404, 404]);
});

test("makes an Environment once, with a key, under a name runners can use", async () => {
  const create = async (name: string): Promise<Response> =>
    fetch(new URL("/api/environments", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await signedIn() },
      body: JSON.stringify({ name }),
    });

  const created = await create("builders");

  const body = (await created.json()) as {
    environment: Environment;
    key: string;
  };

  expect(created.status).toBe(201);
  expect(body.environment).toMatchObject({ name: "builders", hasKey: true });
  expect(body.key).toStartWith("pck_");
  expect((await create("builders")).status).toBe(409);
  expect((await create("no spaces")).status).toBe(400);
});

test("reports the Sessions beyond the room an Environment's online runners have", async () => {
  await claimed("mac-1", { capacity: 1 });

  await startSession("/srv/a");
  const second = await startSession("/srv/b");

  expect(await unplaced()).toEqual([second]);
});

test("leaves a folder Session to the full runner that lists its folder", async () => {
  await claimed("mac-1", { folders: ["/srv/a"], capacity: 1 });
  await startSession("/srv/b");
  await claimed("mac-1", { folders: ["/srv/a"], capacity: 1 });

  await startSession("/srv/a/app");

  expect(await unplaced()).toEqual([]);
});

test("reports a clone Session whose runner went offline once its lease lapses", async () => {
  await server.stop();
  startServer({ offlineAfterMs: 100 });
  await claimed("mac-1");

  const clone = await startSession({
    kind: "clone",
    repository: "https://example.com/app.git",
  });

  await claimed("mac-1");
  await sleep(150);
  const beforeLease = await unplaced();
  await sleep(leaseMs);

  expect(beforeLease).toEqual([]);
  expect(await unplaced()).toEqual([clone]);
});

test("gives no work to a runner revoked while it waited for some", async () => {
  await server.stop();
  startServer({ pollWaitMs: 10_000 });
  await runners.key("pods");

  const id = await environmentId("pods");
  const token = machines?.runnerToken(id, "pod-1");
  const waited = asRunner(token, "/agent/work", emptyPoll);

  await sleep(100);
  machines?.revokeRunner(id, "pod-1");

  await fetch(new URL("/api/sessions", server.url), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: await signedIn() },
    body: JSON.stringify({
      environment: id,
      workspace: { kind: "folder", path: "/srv/a" },
    }),
  });

  expect((await waited).status).toBe(401);
});

test("gives a reserved Session only to its runner, which takes no other", async () => {
  await claimed("mac-1");

  const reserved = await startSession({
    kind: "clone",
    repository: "https://example.com/a.git",
  });

  const other = await startSession({
    kind: "clone",
    repository: "https://example.com/b.git",
  });

  machines?.reserve(reserved, "pod-b");
  const waiting = await unplaced();
  const onMac = await claimed("mac-1");
  const onPod = await claimed("pod-b");

  await startSession({
    kind: "clone",
    repository: "https://example.com/c.git",
  });

  const [attempt] = onPod;

  const later = await claimed("pod-b", {
    running: attempt === undefined ? [] : [attempt],
  });

  expect(waiting).toEqual([reserved]);
  expect(ids(onMac)).toEqual([other]);
  expect(ids(onPod)).toEqual([reserved]);
  expect(later).toEqual([]);
  expect(await unplaced()).toEqual([]);
});
