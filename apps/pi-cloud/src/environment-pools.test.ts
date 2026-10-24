import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  type Assignment,
  type Attempt,
  type Environment,
  environmentHeader,
  protocolVersion,
  providerHeader,
  versionHeader,
  type WorkPoll,
} from "@pi-cloud/protocol";
import { serve } from "./serve";

let server: ReturnType<typeof serve>;

beforeEach(() => {
  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 0 },
    log: () => undefined,
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
  }: {
    readonly folders?: readonly string[];
    readonly running?: readonly Attempt[];
    readonly capacity?: number;
  } = {},
): Promise<readonly Assignment[]> {
  const body: WorkPoll = {
    running,
    folders,
    models: [],
    ...(capacity !== undefined && { capacity }),
  };

  const work = await json<{ readonly start: readonly Assignment[] }>(
    fetch(new URL("/agent/work", server.url), {
      method: "POST",
      headers: {
        [versionHeader]: String(protocolVersion),
        [providerHeader]: runner,
        [environmentHeader]: "laptops",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );

  return work.start;
}

async function startSession(path: string): Promise<string> {
  const session = await json<{ readonly id: string }>(
    fetch(new URL("/api/sessions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: { kind: "folder", path } }),
    }),
  );

  return session.id;
}

function ids(assignments: readonly Assignment[]): readonly string[] {
  return assignments.map(({ sessionId }) => sessionId);
}

test("lists every runner that joined an Environment's pool", async () => {
  await poll("mac-1", { folders: ["/srv/a"], capacity: 2 });
  await poll("mac-2", { folders: ["/srv/b"] });

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
  await poll("mac-1", { folders: ["/srv/a"] });
  await poll("mac-2", { folders: ["/srv/b"] });

  const id = await startSession("/srv/b/app");

  const onFirst = await poll("mac-1", { folders: ["/srv/a"] });
  const onSecond = await poll("mac-2", { folders: ["/srv/b"] });

  expect(onFirst).toEqual([]);
  expect(ids(onSecond)).toEqual([id]);
});

test("gives a runner no more Sessions than its capacity has room for", async () => {
  await poll("mac-1", { capacity: 1 });

  const first = await startSession("/srv/a");
  const second = await startSession("/srv/b");

  const [assigned] = await poll("mac-1", { capacity: 1 });
  if (!assigned) {
    throw new Error("no session was assigned");
  }

  const whileFull = await poll("mac-1", {
    capacity: 1,
    running: [
      { sessionId: assigned.sessionId, generation: assigned.generation },
    ],
  });

  expect(assigned.sessionId).toBe(first);
  expect(whileFull).toEqual([]);
  expect(ids(await poll("mac-2"))).toEqual([second]);
});

test("sends an interrupted Session back to the runner it ran on", async () => {
  await poll("mac-1");

  const id = await startSession("/srv/a");

  expect(ids(await poll("mac-1"))).toEqual([id]);

  // mac-1 no longer reports the attempt and has no room to take it again.
  await poll("mac-1", {
    capacity: 1,
    running: [{ sessionId: "other", generation: 1 }],
  });

  expect(await poll("mac-2")).toEqual([]);
  expect(ids(await poll("mac-1"))).toEqual([id]);
});
