import { afterEach, beforeEach, expect, test } from "bun:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  eventBus,
  type EventBus,
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

interface Logged {
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
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
  readonly events: EventBus;
  readonly delivered: Delivered[];
  readonly transcripts: Map<string, string[]>;
  readonly route: () => PluginRoute;
  readonly tool: (name: string) => ServerTool;
  readonly session: (id: string) => Session;
  readonly offline: Set<string>;
  readonly refused: string[];
  readonly unreadable: Set<string>;
  readonly logged: Logged[];
} {
  const db = new DatabaseSync(":memory:");
  const sessions = new Map<string, Session>();
  const transcripts = new Map<string, string[]>();
  const tools = new Map<string, ServerTool>();
  const delivered: Delivered[] = [];
  const offline = new Set<string>();
  const refused: string[] = [];
  const unreadable = new Set<string>();
  const logged: Logged[] = [];
  let route: PluginRoute | undefined;

  const events = eventBus((_type, error) => {
    throw error;
  });

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
    events,
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
      transcript: (id) => {
        if (unreadable.has(id)) {
          throw new Error(`transcript of ${id} is unreadable`);
        }

        return [...(transcripts.get(id) ?? [])];
      },
      transcriptLength: (id) => transcripts.get(id)?.length ?? 0,
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
    log: (message, fields) => {
      logged.push({ message, fields });
    },
  };

  return {
    context,
    events,
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
    unreadable,
    logged,
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

const bashLine = JSON.stringify({
  type: "message",
  message: {
    role: "bashExecution",
    command: "git status",
    output: "clean",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 1,
  },
});

const cutLine = '{"type":"message","message":{"role":"assis';

function turn(
  kernel: FakeKernel,
  threadId: string,
  lines: readonly string[],
): void {
  const session = kernel.session(threadId);

  kernel.events.publish({
    type: "TurnStarted",
    session: { ...session, status: "running" },
  });

  kernel.transcripts.get(threadId)?.push(...lines);

  kernel.events.publish({ type: "TurnEnded", session });
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

test("drops a delivery it can't build, once, so later ones still reach the coordinator", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { threadId } = await startProject(kernel);

  const thread = {
    session: kernel.session(threadId),
    actor: `session:${threadId}` as const,
  };

  turn(kernel, threadId, [
    userLine("bump the version"),
    replyLine("bumped to v2"),
  ]);

  kernel.unreadable.add(threadId);

  const messageCoordinator = kernel.tool("message_coordinator");
  await messageCoordinator.run({ text: "need a decision" }, thread);
  await until(() => kernel.delivered.length > 0);

  await messageCoordinator.run({ text: "still need it" }, thread);
  await until(() => kernel.delivered.length > 1);

  expect(kernel.delivered).toEqual([
    {
      kind: "send",
      text: `[Thread "Bump version" (${threadId})] need a decision`,
    },
    {
      kind: "send",
      text: `[Thread "Bump version" (${threadId})] still need it`,
    },
  ]);

  const failures = kernel.logged.filter(({ fields }) =>
    String(fields?.["error"]).includes("unreadable"),
  );

  expect(failures).toHaveLength(1);
}, 10_000);

test("refuses memory file names made only of dots", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { coordinatorId } = await startProject(kernel);

  const coordinator = {
    session: kernel.session(coordinatorId),
    actor: user,
  };

  const memoryWrite = kernel.tool("memory_write");

  const results = await Promise.all(
    [".", "..", ".notes"].map(async (name) =>
      memoryWrite.run({ name, content: "notes" }, coordinator),
    ),
  );

  expect(results.map(({ isError }) => isError)).toEqual([true, true, false]);
}, 10_000);

test("quotes a thread's reply when later transcript lines can't be read as text", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { threadId } = await startProject(kernel);

  turn(kernel, threadId, [
    userLine("bump the version"),
    replyLine("bumped to v2"),
    bashLine,
    cutLine,
  ]);

  await until(() => kernel.delivered.length > 0);

  expect(kernel.delivered[0]?.kind).toBe("send");
  expect(kernel.delivered[0]?.text).toContain("finished a turn");
  expect(kernel.delivered[0]?.text).toContain("Its last reply: bumped to v2");
}, 10_000);

test("reads a thread's messages around transcript lines that aren't text", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { coordinatorId, threadId } = await startProject(kernel);

  kernel.transcripts
    .get(threadId)
    ?.push(userLine("bump the version"), cutLine, bashLine, replyLine("done"));

  const read = await kernel
    .tool("read_thread")
    .run(
      { thread: threadId },
      { session: kernel.session(coordinatorId), actor: user },
    );

  expect(read).toEqual({
    text: [
      'Thread "Bump version", page 1 of 1, oldest first:',
      "[user] bump the version",
      "[assistant] done",
    ].join("\n\n"),
    isError: false,
  });
});

async function projectView(kernel: FakeKernel): Promise<ProjectView> {
  const list = await kernel.route()(
    new Request("http://pi-cloud/projects"),
    "projects",
    undefined,
  );

  const [summary] = (await list.json()) as { id: string }[];

  const response = await kernel.route()(
    new Request(`http://pi-cloud/projects/${summary?.id ?? ""}`),
    `projects/${summary?.id ?? ""}`,
    undefined,
  );

  return (await response.json()) as ProjectView;
}

async function messageProject(
  kernel: FakeKernel,
  text: unknown,
): Promise<Response> {
  const { id } = await projectView(kernel);

  return kernel.route()(
    new Request(`http://pi-cloud/projects/${id}/message`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
    `projects/${id}/message`,
    undefined,
  );
}

test("shows the coordinator's last reply on the Project", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { coordinatorId } = await startProject(kernel);

  expect((await projectView(kernel)).coordinatorSays).toBeNull();

  kernel.transcripts
    .get(coordinatorId)
    ?.push(userLine("how is it going?"), replyLine("One thread needs you."));

  expect((await projectView(kernel)).coordinatorSays).toBe(
    "One thread needs you.",
  );

  kernel.unreadable.add(coordinatorId);

  expect((await projectView(kernel)).coordinatorSays).toBeNull();
});

test("sends a message from the Project page to its coordinator, even while it is offline", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { coordinatorId } = await startProject(kernel);

  expect((await messageProject(kernel, "start a docs thread")).status).toBe(
    202,
  );

  expect(kernel.delivered).toEqual([
    { kind: "send", text: "start a docs thread" },
  ]);

  expect((await messageProject(kernel, "  ")).status).toBe(400);

  kernel.offline.add(coordinatorId);
  expect((await messageProject(kernel, "again")).status).toBe(202);
  expect(kernel.delivered).toHaveLength(1);

  kernel.offline.delete(coordinatorId);
  await until(() => kernel.delivered.length > 1);

  expect(kernel.delivered[1]).toEqual({ kind: "send", text: "again" });
}, 10_000);
