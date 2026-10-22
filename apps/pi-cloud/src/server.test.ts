import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { eventBus, type ServerPlugin } from "@pi-cloud/plugins";
import {
  type Assignment,
  protocolVersion,
  providerHeader,
  versionHeader,
  type WorkPoll,
} from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";
import { Sessions } from "@pi-cloud/sessions";
import { startPlugins } from "./plugins";
import { createHandler } from "./server";
import { readSse } from "./sse";
import { openStore } from "./store";

test("reports unhealthy when the database can't be read", async () => {
  const store = openStore(":memory:");

  const sessions = new Sessions(store);

  const handler = createHandler(
    sessions,
    startPlugins([], [], {
      sessions,
      events: eventBus(() => undefined),
      store: store.plugin,
      signal: new AbortController().signal,
      log: () => undefined,
    }),
    store.check,
    () => undefined,
  );

  store.close();

  const response = await handler(new Request("http://127.0.0.1/healthz"));

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ status: "unavailable" });
});

const echo: ServerPlugin = {
  name: "echo",
  register: ({ tools }) => {
    tools.register({
      name: "echo",
      description: "Says its input back",
      parameters: { type: "object" },
      appliesTo: () => true,
      run: async (input) =>
        Promise.resolve({ text: JSON.stringify(input), isError: false }),
    });
  },
};

const poll: WorkPoll = { running: [], folders: [], models: [] };

function startServer(log: Log): {
  readonly call: (path: string, body?: unknown) => Promise<Response>;
  readonly claim: () => Promise<Assignment>;
  readonly stop: () => void;
} {
  const store = openStore(":memory:");
  const sessions = new Sessions(store, { pollWaitMs: 0 });
  const stopped = new AbortController();

  const handler = createHandler(
    sessions,
    startPlugins([echo], [echo.name], {
      sessions,
      events: eventBus(() => undefined),
      store: store.plugin,
      signal: stopped.signal,
      log,
    }),
    store.check,
    () => undefined,
  );

  const call = async (path: string, body?: unknown): Promise<Response> =>
    handler(
      new Request(`http://127.0.0.1${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          [versionHeader]: String(protocolVersion),
          [providerHeader]: "local",
          "content-type": "application/json",
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );

  return {
    call,
    claim: async () => {
      await call("/agent/work", poll);

      await call("/api/sessions", {
        workspace: { kind: "folder", path: "/srv/app" },
      });

      const work = (await (await call("/agent/work", poll)).json()) as {
        start: Assignment[];
      };

      const [assignment] = work.start;
      if (!assignment) {
        throw new Error("no session was assigned");
      }

      return assignment;
    },
    stop: () => {
      stopped.abort();
      sessions.close();
      store.close();
    },
  };
}

test("delivers a server tool's result that finished while the command stream was away", async () => {
  const server = startServer(() => undefined);
  const { sessionId, generation } = await server.claim();

  const called = await server.call(`/agent/sessions/${sessionId}/tool-calls`, {
    generation,
    id: "call-1",
    name: "echo",
    input: { say: "hi" },
  });

  await sleep(0);

  const stream = await server.call(
    `/agent/sessions/${sessionId}/commands?generation=${String(generation)}`,
  );

  const commands: unknown[] = [];
  for await (const command of readSse(stream, 3000)) {
    commands.push(command);
    break;
  }

  await server.call(`/api/sessions/${sessionId}/archive`, {});
  server.stop();

  expect(called.status).toBe(202);

  expect(commands).toEqual([
    {
      actor: "plugin:echo",
      type: "tool_result",
      id: "call-1",
      result: { text: '{"say":"hi"}', isError: false },
    },
  ]);
});

test("drops and logs a waiting tool result once its attempt is no longer current", async () => {
  const { promise: dropped, resolve } =
    Promise.withResolvers<Readonly<Record<string, unknown>>>();

  const server = startServer((message, fields) => {
    if (message === "tool result dropped") {
      resolve(fields ?? {});
    }
  });

  const { sessionId, generation } = await server.claim();

  await server.call(`/agent/sessions/${sessionId}/tool-calls`, {
    generation,
    id: "call-1",
    name: "echo",
    input: {},
  });

  await sleep(0);
  await server.call(`/api/sessions/${sessionId}/archive`, {});

  expect(await dropped).toEqual({
    sessionId,
    generation,
    tool: "echo",
    callId: "call-1",
    reason: "stale_generation",
  });

  server.stop();
});
