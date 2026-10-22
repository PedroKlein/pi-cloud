import { afterEach, beforeEach, expect, test } from "bun:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  eventBus,
  type PluginRoute,
  type SendOutcome,
  type ServerPluginContext,
  type ServerTool,
} from "@pi-cloud/plugins";
import type { Actor, Session } from "@pi-cloud/protocol";
import type { ProjectView } from "./model";
import { projects } from "./server";

interface Delivered {
  readonly kind: "send" | "notify";
  readonly text: string;
}

type FakeKernel = ReturnType<typeof fakeKernel>;

let stop: AbortController;

beforeEach(() => {
  stop = new AbortController();
});

afterEach(() => {
  stop.abort();
});

const user: Actor = "user:pedro";

function fakeKernel(): {
  readonly context: ServerPluginContext;
  readonly delivered: Delivered[];
  readonly transcripts: Map<string, string[]>;
  readonly route: () => PluginRoute;
  readonly tool: (name: string) => ServerTool;
  readonly session: (id: string) => Session;
  readonly offline: Set<string>;
  readonly refused: string[];
} {
  const db = new DatabaseSync(":memory:");
  const sessions = new Map<string, Session>();
  const transcripts = new Map<string, string[]>();
  const tools = new Map<string, ServerTool>();
  const delivered: Delivered[] = [];
  const offline = new Set<string>();
  const refused: string[] = [];
  let route: PluginRoute | undefined;

  const deliver = (
    kind: Delivered["kind"],
    sessionId: string,
    text: string,
  ): SendOutcome => {
    if (offline.has(sessionId)) {
      refused.push(text);

      return { ok: false, reason: "offline" };
    }

    delivered.push({ kind, text });

    return { ok: true };
  };

  const context: ServerPluginContext = {
    owner: "pedro",
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool);
      },
    },
    events: eventBus((_type, error) => {
      throw error;
    }),
    sessions: {
      start: (request) => {
        const id = `session-${String(sessions.size + 1)}`;

        const session: Session = {
          id,
          environmentId: request.environment ?? "laptop",
          ownerId: "pedro",
          provider: "local",
          workspace: { kind: "folder", path: "/work" },
          model: null,
          systemPrompt: request.systemPrompt ?? null,
          firstMessage: request.firstMessage ?? null,
          title: null,
          status: "idle",
          generation: 1,
          createdAt: new Date().toISOString(),
          interruptedAt: null,
          error: null,
          archivedAt: null,
          workspaceRemoval: null,
          online: true,
        };

        sessions.set(id, session);
        transcripts.set(id, []);

        return session;
      },
      get: (id) => sessions.get(id),
      send: (id, text) => deliver("send", id, text),
      notify: (id, text) => deliver("notify", id, text),
      transcript: (id) => [...(transcripts.get(id) ?? [])],
    },
    routes: {
      handle: (handler) => {
        route = handler;
      },
    },
    models: { offer: () => undefined },
    store: {
      exec: (sql) => {
        db.exec(sql);
      },
      all: (sql, ...params) =>
        db.prepare(sql).all(...(params as SQLInputValue[])),
      run: (sql, ...params) => {
        db.prepare(sql).run(...(params as SQLInputValue[]));
      },
    },
    signal: stop.signal,
    log: () => undefined,
  };

  return {
    context,
    delivered,
    transcripts,
    route: () => {
      if (route === undefined) {
        throw new Error("no route registered");
      }

      return route;
    },
    tool: (name) => {
      const found = tools.get(name);
      if (found === undefined) {
        throw new Error(`no tool ${name}`);
      }

      return found;
    },
    session: (id) => {
      const found = sessions.get(id);
      if (found === undefined) {
        throw new Error(`no session ${id}`);
      }

      return found;
    },
    offline,
    refused,
  };
}

async function startProject(
  kernel: FakeKernel,
): Promise<{ coordinatorId: string; threadId: string }> {
  const response = await kernel.route()(
    new Request("http://pi-cloud/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Release",
        repositories: ["https://example.com/app.git"],
      }),
    }),
    "projects",
    undefined,
  );

  const { coordinatorId } = (await response.json()) as ProjectView;

  const started = await kernel
    .tool("start_thread")
    .run(
      { title: "Bump version", message: "bump the version" },
      { session: kernel.session(coordinatorId), actor: user },
    );

  const threadId = /as (\S+)\.$/.exec(started.text)?.[1] ?? "";

  return { coordinatorId, threadId };
}

const userLine = (text: string): string =>
  JSON.stringify({ type: "message", message: { role: "user", content: text } });

const replyLine = (text: string): string =>
  JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    },
  });

const errorLine = (error: string): string =>
  JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: error,
    },
  });

const toolCallLines = (name: string, result: string): string[] => [
  JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name, arguments: {} }],
      stopReason: "toolUse",
    },
  }),
  JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: name,
      content: [{ type: "text", text: result }],
    },
  }),
];

function turn(
  kernel: FakeKernel,
  threadId: string,
  lines: readonly string[],
): void {
  const session = kernel.session(threadId);

  kernel.context.events.publish({
    type: "TurnStarted",
    session: { ...session, status: "running" },
  });

  kernel.transcripts.get(threadId)?.push(...lines);

  kernel.context.events.publish({ type: "TurnEnded", session });
}

async function until(done: () => boolean): Promise<void> {
  while (!done()) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("delivers each thread turn held for an offline coordinator with its own reply", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { coordinatorId, threadId } = await startProject(kernel);

  kernel.offline.add(coordinatorId);

  turn(kernel, threadId, [
    userLine("bump the version"),
    replyLine("first result"),
  ]);

  turn(kernel, threadId, [
    userLine("check the tag"),
    replyLine("second result"),
  ]);

  await until(() => kernel.refused.length > 0);
  kernel.offline.delete(coordinatorId);

  await until(() => kernel.delivered.length >= 2);

  expect(kernel.delivered.map(({ kind }) => kind)).toEqual(["send", "send"]);
  expect(kernel.delivered[0]?.text).toContain("Its last reply: first result");
  expect(kernel.delivered[1]?.text).toContain("Its last reply: second result");
}, 10_000);

test("wakes an offline coordinator only for the held thread turns that ended well", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { coordinatorId, threadId } = await startProject(kernel);

  kernel.offline.add(coordinatorId);

  turn(kernel, threadId, [
    userLine("bump the version"),
    replyLine("first result"),
  ]);

  turn(kernel, threadId, [userLine("check the tag"), errorLine("429 quota")]);

  await until(() => kernel.refused.length > 0);
  kernel.offline.delete(coordinatorId);

  await until(() => kernel.delivered.length >= 2);

  expect(kernel.delivered.map(({ kind }) => kind)).toEqual(["send", "notify"]);
  expect(kernel.delivered[0]?.text).toContain("finished a turn");
  expect(kernel.delivered[1]?.text).toContain("model error: 429 quota");
}, 10_000);

test("quotes a thread's last text reply when its turn ends on a tool call", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { threadId } = await startProject(kernel);

  turn(kernel, threadId, [
    userLine("bump the version"),
    replyLine("bumped to v2"),
    ...toolCallLines("set_status", "Work state set to review_ready."),
  ]);

  await until(() => kernel.delivered.length > 0);

  expect(kernel.delivered[0]?.text).toContain("Its last reply: bumped to v2");
}, 10_000);
