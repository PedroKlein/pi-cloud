import { afterEach, beforeEach, expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Assignment,
  type Attempt,
  type Environment,
  type Session,
  type WorkspaceRequest,
  environmentHeader,
  protocolVersion,
  providerHeader,
  versionHeader,
  type WorkPoll,
} from "@pi-cloud/protocol";
import { serve } from "./serve";

const leaseMs = 200;

let server: ReturnType<typeof serve>;
let logged: string[];

beforeEach(() => {
  logged = [];

  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 0, leaseMs },
    log: (message, fields) => {
      logged.push(`${message} ${JSON.stringify(fields)}`);
    },
  });
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
        [providerHeader]: runner,
        [environmentHeader]: environment,
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
      headers: { "content-type": "application/json" },
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

function ids(assignments: readonly Assignment[]): readonly string[] {
  return assignments.map(({ sessionId }) => sessionId);
}

test("lists every runner that joined an Environment's pool", async () => {
  await claimed("mac-1", { folders: ["/srv/a"], capacity: 2 });
  await claimed("mac-2", { folders: ["/srv/b"] });

  const environments = await json<Environment[]>(
    fetch(new URL("/api/environments", server.url)),
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
    fetch(new URL(`/api/sessions/${clone}`, server.url)),
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
    fetch(new URL(`/api/sessions/${id}`, server.url)),
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
    fetch(new URL("/api/environments", server.url)),
  );

  await fetch(
    new URL(`/api/environments/${environment?.id ?? ""}`, server.url),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
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
    fetch(new URL("/api/environments", server.url)),
  );

  const elsewhere = environments.find(
    ({ provider }) => provider === "elsewhere",
  );

  const fork = async (id: string): Promise<Response> =>
    fetch(new URL(`/api/sessions/${id}/fork`, server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
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
