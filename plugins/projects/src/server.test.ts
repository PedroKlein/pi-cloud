import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  eventBus,
  type EventBus,
  type PluginNotice,
  type PluginRoute,
  type SendOutcome,
  type ServerPluginContext,
  type ServerTool,
} from "@pipoca/plugins";
import {
  fakeContext,
  fakeSession,
  fakeUser,
  served,
} from "@pipoca/plugins/testing";
import type { Actor, Session } from "@pipoca/protocol";
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
const pedro = fakeUser({ id: "pedro", admin: true });

function fakeKernel(): {
  readonly context: ServerPluginContext;
  readonly events: EventBus;
  readonly delivered: Delivered[];
  readonly notices: (PluginNotice | undefined)[];
  readonly transcripts: Map<string, string[]>;
  readonly route: () => PluginRoute;
  readonly tool: (name: string) => ServerTool;
  readonly session: (id: string) => Session;
  readonly update: (id: string, changes: Partial<Session>) => void;
  readonly offline: Set<string>;
  readonly refused: string[];
  readonly unreadable: Set<string>;
  readonly stuck: Set<string>;
  readonly logged: Logged[];
} {
  const sessions = new Map<string, Session>();
  const transcripts = new Map<string, string[]>();
  const tools = new Map<string, ServerTool>();
  const delivered: Delivered[] = [];
  const notices: (PluginNotice | undefined)[] = [];
  const offline = new Set<string>();
  const refused: string[] = [];
  const unreadable = new Set<string>();
  const stuck = new Set<string>();
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

  const context = fakeContext({
    owner: "pedro",
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool);
      },
    },
    events,
    sessions: {
      loadOnly: () => undefined,
      start: (request, ownerKey) => {
        const id = `session-${String(sessions.size + 1)}`;

        const session = fakeSession({
          id,
          environmentId: request.environment ?? "laptop",
          ownerId: "pedro",
          owner:
            ownerKey === undefined
              ? null
              : { plugin: "projects", key: ownerKey },
          profileId: request.profile ?? "profile-1",
          model: request.model ?? null,
          thinking: request.thinking ?? null,
          systemPrompt: request.systemPrompt ?? null,
          firstMessage: request.firstMessage ?? null,
          createdAt: new Date().toISOString(),
        });

        sessions.set(id, session);
        transcripts.set(id, []);

        return session;
      },
      get: (id) => sessions.get(id),
      owned: (key, { archived = false } = {}) =>
        [...sessions.values()].filter(
          (session) =>
            session.owner?.key === key &&
            (archived || session.archivedAt === null),
        ),
      adopt: (id, key) => {
        const session = sessions.get(id);
        if (session?.owner === null) {
          sessions.set(id, { ...session, owner: { plugin: "projects", key } });
        }
      },
      archive: (id) => {
        if (stuck.has(id)) {
          throw new Error(`${id} is stuck`);
        }

        const session = sessions.get(id);
        if (session?.archivedAt === null) {
          const archived: Session = {
            ...session,
            status: "stopped",
            archivedAt: new Date().toISOString(),
          };

          sessions.set(id, archived);
          events.publish({ type: "SessionArchived", session: archived });
        }
      },
      unarchive: (id) => {
        if (stuck.has(id)) {
          throw new Error(`${id} is stuck`);
        }

        const session = sessions.get(id);
        if (session && session.archivedAt !== null) {
          const back: Session = {
            ...session,
            status: "idle",
            archivedAt: null,
          };

          sessions.set(id, back);

          events.publish({
            type: "SessionUnarchived",
            session: back,
            archivedAt: session.archivedAt,
          });
        }
      },
      send: (id, text, _actor, notice) => {
        notices.push(notice);

        return deliver("send", id, text);
      },
      notify: (id, text, _actor, notice) => {
        notices.push(notice);

        return deliver("notify", id, text);
      },
      transcript: (id) => {
        if (unreadable.has(id)) {
          throw new Error(`transcript of ${id} is unreadable`);
        }

        return [...(transcripts.get(id) ?? [])];
      },
      transcriptLength: (id) => transcripts.get(id)?.length ?? 0,
    },
    toolsets: {
      register: () => undefined,
      loadInOwnSessions: () => undefined,
      asks: async () => Promise.resolve(undefined),
    },
    routes: {
      handle: (handler) => {
        route = served(handler);
      },
    },
    signal: stop.signal,
    log: (message, fields) => {
      logged.push({ message, fields });
    },
  });

  return {
    context,
    events,
    delivered,
    notices,
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
    update: (id, changes) => {
      const found = sessions.get(id);
      if (found !== undefined) {
        sessions.set(id, { ...found, ...changes });
      }
    },
    offline,
    refused,
    unreadable,
    stuck,
    logged,
  };
}

async function startProject(
  kernel: FakeKernel,
): Promise<{ coordinatorId: string; threadId: string }> {
  const response = await kernel.route()(
    new Request("http://pipoca/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Release",
        repositories: ["https://example.com/app.git"],
      }),
    }),
    "projects",
    pedro,
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

function turnStarted(kernel: FakeKernel, threadId: string): void {
  kernel.events.publish({
    type: "TurnStarted",
    session: { ...kernel.session(threadId), status: "running" },
  });
}

// transcriptLength is how many lines the thread's host says the turn ended
// with, whether or not they have reached the server yet.
function turnEnded(
  kernel: FakeKernel,
  threadId: string,
  transcriptLength?: number,
): void {
  kernel.events.publish({
    type: "TurnEnded",
    session: kernel.session(threadId),
    ...(transcriptLength !== undefined && { transcriptLength }),
  });
}

function turn(
  kernel: FakeKernel,
  threadId: string,
  lines: readonly string[],
): void {
  const transcript = kernel.transcripts.get(threadId) ?? [];

  turnStarted(kernel, threadId);
  transcript.push(...lines);
  turnEnded(kernel, threadId, transcript.length);
}

async function until(done: () => boolean): Promise<void> {
  while (!done()) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("owns its coordinator and threads, and those started before owners existed", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { coordinatorId, threadId } = await startProject(kernel);

  const listed = await kernel.route()(
    new Request("http://pipoca/projects"),
    "projects",
    pedro,
  );

  const [project] = (await listed.json()) as ProjectView[];
  const owner = { plugin: "projects", key: project?.id ?? "" };
  expect(kernel.session(coordinatorId).owner).toEqual(owner);
  expect(kernel.session(threadId).owner).toEqual(owner);

  kernel.update(coordinatorId, { owner: null });
  kernel.update(threadId, { owner: null });
  projects.register(kernel.context);

  expect(kernel.session(coordinatorId).owner).toEqual(owner);
  expect(kernel.session(threadId).owner).toEqual(owner);
});

test("tags each notice and message with what the chat draws for it", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { coordinatorId, threadId } = await startProject(kernel);
  const thread = { session: kernel.session(threadId), actor: user };

  turn(kernel, threadId, [userLine("bump it"), replyLine("bumped to 2.0")]);
  await until(() => kernel.notices.length > 0);

  await kernel
    .tool("set_status")
    .run({ state: "review_ready", note: "ready" }, thread);

  await kernel.tool("message_coordinator").run({ text: "which tag?" }, thread);

  await kernel
    .tool("message_thread")
    .run(
      { thread: threadId, text: "use v2.0.0" },
      { session: kernel.session(coordinatorId), actor: user },
    );

  await until(() => kernel.notices.length > 3);

  expect(kernel.notices).toEqual([
    {
      kind: "thread",
      data: {
        threadId,
        title: "Bump version",
        event: "finished a turn",
        runState: "idle",
        workState: "in_progress",
        reply: "bumped to 2.0",
      },
    },
    {
      kind: "thread",
      data: {
        threadId,
        title: "Bump version",
        event: "set its work state to review_ready: ready",
        runState: "idle",
        workState: "review_ready",
      },
    },
    {
      kind: "thread_message",
      data: { threadId, title: "Bump version", text: "which tag?" },
    },
    { kind: "coordinator_message", data: { text: "use v2.0.0" } },
  ]);
}, 10_000);

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

test("names a thread turn's model error that reaches the server after the thread's next turn started", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { threadId } = await startProject(kernel);
  const transcript = kernel.transcripts.get(threadId) ?? [];

  turnStarted(kernel, threadId);
  transcript.push(userLine("bump the version"), replyLine("working on it"));
  turnEnded(kernel, threadId, 3);
  turnStarted(kernel, threadId);

  transcript.push(
    errorLine("429 quota"),
    userLine("try again"),
    replyLine("bumped to v2"),
  );

  turnEnded(kernel, threadId, 5);

  await until(() => kernel.delivered.length >= 2);

  expect(kernel.delivered.map(({ kind }) => kind)).toEqual(["notify", "send"]);
  expect(kernel.delivered[0]?.text).toContain("model error: 429 quota");
  expect(kernel.delivered[1]?.text).toContain("Its last reply: bumped to v2");
}, 10_000);

test("wakes the coordinator once for a thread turn that messaged it when the next turn's first line arrives early", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { threadId } = await startProject(kernel);
  const transcript = kernel.transcripts.get(threadId) ?? [];

  turnStarted(kernel, threadId);

  transcript.push(
    userLine("bump the version"),
    ...toolCallLines("message_coordinator", "Message queued."),
    replyLine("asked the coordinator"),
  );

  turnEnded(kernel, threadId, 4);
  transcript.push(userLine("carry on"));
  turnStarted(kernel, threadId);
  transcript.push(replyLine("carried on"));
  turnEnded(kernel, threadId, 6);

  await until(() => kernel.delivered.length >= 2);

  expect(kernel.delivered.map(({ kind }) => kind)).toEqual(["notify", "send"]);

  expect(kernel.delivered[0]?.text).toContain(
    "Its last reply: asked the coordinator",
  );

  expect(kernel.delivered[1]?.text).toContain("Its last reply: carried on");
}, 10_000);

test("holds a thread's turn notice, and what follows it, until the rest of the turn reaches the server", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { threadId } = await startProject(kernel);
  const transcript = kernel.transcripts.get(threadId) ?? [];
  const messageCoordinator = kernel.tool("message_coordinator");

  const thread = {
    session: kernel.session(threadId),
    actor: `session:${threadId}` as const,
  };

  const asked = messageCoordinator.run({ text: "need a decision" }, thread);
  turnStarted(kernel, threadId);
  transcript.push(userLine("bump the version"));
  turnEnded(kernel, threadId, 2);
  const followed = messageCoordinator.run({ text: "and another" }, thread);
  await Promise.all([asked, followed]);

  await until(() => kernel.delivered.length > 0);

  expect(kernel.delivered).toEqual([
    {
      kind: "send",
      text: `[Thread "Bump version" (${threadId})] need a decision`,
    },
  ]);

  transcript.push(replyLine("bumped to v2"));
  await until(() => kernel.delivered.length >= 3);

  expect(kernel.delivered[1]?.text).toContain("Its last reply: bumped to v2");
  expect(kernel.delivered[2]?.text).toContain("and another");
}, 10_000);

test("keeps a thread turn's notice as context when its model error reaches the server after the turn ended", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { threadId } = await startProject(kernel);
  const transcript = kernel.transcripts.get(threadId) ?? [];

  const asked = kernel
    .tool("message_coordinator")
    .run(
      { text: "need a decision" },
      { session: kernel.session(threadId), actor: `session:${threadId}` },
    );

  turnStarted(kernel, threadId);
  transcript.push(userLine("bump the version"));
  turnEnded(kernel, threadId, 2);
  await asked;

  await until(() => kernel.delivered.length > 0);
  expect(kernel.delivered).toHaveLength(1);

  transcript.push(errorLine("429 quota"));
  await until(() => kernel.delivered.length > 1);

  expect(kernel.delivered[1]?.kind).toBe("notify");
  expect(kernel.delivered[1]?.text).toContain("model error: 429 quota");
}, 10_000);

test("gives the coordinator a held turn notice with what reached the server once the thread is archived", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { threadId } = await startProject(kernel);
  const transcript = kernel.transcripts.get(threadId) ?? [];

  turnStarted(kernel, threadId);
  transcript.push(userLine("bump the version"), replyLine("working on it"));
  turnEnded(kernel, threadId, 3);
  kernel.update(threadId, { archivedAt: new Date().toISOString() });

  await until(() => kernel.delivered.length > 0);

  expect(kernel.delivered[0]?.text).toContain("Its last reply: working on it");
}, 10_000);

test("reads a thread's whole transcript for a turn notice when its host doesn't say where the turn ended", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { threadId } = await startProject(kernel);
  const transcript = kernel.transcripts.get(threadId) ?? [];

  turnStarted(kernel, threadId);
  transcript.push(userLine("bump the version"));
  turnEnded(kernel, threadId);
  transcript.push(replyLine("bumped to v2"));

  await until(() => kernel.delivered.length > 0);

  expect(kernel.delivered[0]?.text).toContain("Its last reply: bumped to v2");
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

test("keeps delivering, and sends nothing twice, while the store can't delete a delivered message", async () => {
  const kernel = fakeKernel();
  let locked = true;

  projects.register({
    ...kernel.context,
    store: {
      ...kernel.context.store,
      run: (sql, ...params) => {
        if (locked && sql.startsWith("delete from projects_outbox")) {
          throw new Error("database is locked");
        }

        kernel.context.store.run(sql, ...params);
      },
    },
  });

  const { threadId } = await startProject(kernel);

  await kernel
    .tool("message_coordinator")
    .run(
      { text: "need a decision" },
      { session: kernel.session(threadId), actor: `session:${threadId}` },
    );

  await until(() => kernel.delivered.length > 0);

  await kernel
    .tool("message_coordinator")
    .run(
      { text: "carry on" },
      { session: kernel.session(threadId), actor: `session:${threadId}` },
    );

  locked = false;
  await until(() => kernel.delivered.length > 1);

  expect(kernel.delivered).toEqual([
    {
      kind: "send",
      text: `[Thread "Bump version" (${threadId})] need a decision`,
    },
    {
      kind: "send",
      text: `[Thread "Bump version" (${threadId})] carry on`,
    },
  ]);

  expect(
    kernel.logged.some(({ fields }) =>
      String(fields?.["error"]).includes("database is locked"),
    ),
  ).toBe(true);
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
    new Request("http://pipoca/projects"),
    "projects",
    pedro,
  );

  const [summary] = (await list.json()) as { id: string }[];

  const response = await kernel.route()(
    new Request(`http://pipoca/projects/${summary?.id ?? ""}`),
    `projects/${summary?.id ?? ""}`,
    pedro,
  );

  return (await response.json()) as ProjectView;
}

async function editProject(
  kernel: FakeKernel,
  changes: unknown,
): Promise<Response> {
  const { id } = await projectView(kernel);

  return kernel.route()(
    new Request(`http://pipoca/projects/${id}/settings`, {
      method: "POST",
      body: JSON.stringify(changes),
    }),
    `projects/${id}/settings`,
    pedro,
  );
}

test("renames a Project and changes the model new threads start on", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { coordinatorId } = await startProject(kernel);

  const edited = await editProject(kernel, {
    name: " Ship ",
    threadModel: "openai/gpt-5",
    instructions: "Keep PRs small.",
  });

  expect(await edited.json()).toMatchObject({
    name: "Ship",
    threadModel: "openai/gpt-5",
    instructions: "Keep PRs small.",
  });

  const started = await kernel
    .tool("start_thread")
    .run(
      { title: "Docs", message: "write docs" },
      { session: kernel.session(coordinatorId), actor: user },
    );

  const threadId = /as (\S+)\.$/.exec(started.text)?.[1] ?? "";

  expect(kernel.session(threadId).model).toEqual({
    provider: "openai",
    id: "gpt-5",
  });

  await editProject(kernel, { threadModel: "" });

  expect(await projectView(kernel)).toMatchObject({
    name: "Ship",
    threadModel: null,
    instructions: "Keep PRs small.",
  });

  expect((await editProject(kernel, { name: " " })).status).toBe(400);
  expect((await editProject(kernel, { threadModel: "gpt" })).status).toBe(400);
  expect((await projectView(kernel)).name).toBe("Ship");
});

test("keeps a Project's goal in the context of the coordinator and its threads without sending it", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);

  const response = await kernel.route()(
    new Request("http://pipoca/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Release",
        repositories: ["https://example.com/app.git"],
        goal: "Ship version 2 by Friday.",
      }),
    }),
    "projects",
    pedro,
  );

  const { coordinatorId, goal } = (await response.json()) as ProjectView;
  const coordinator = kernel.session(coordinatorId);

  expect(goal).toBe("Ship version 2 by Friday.");
  expect(coordinator.systemPrompt).toContain("Ship version 2 by Friday.");
  expect(coordinator.firstMessage).toBeNull();

  await editProject(kernel, { goal: "Ship version 3." });

  const started = await kernel
    .tool("start_thread")
    .run(
      { title: "Docs", message: "write docs" },
      { session: coordinator, actor: user },
    );

  const threadId = /as (\S+)\.$/.exec(started.text)?.[1] ?? "";

  expect(kernel.session(threadId).systemPrompt).toContain("Ship version 3.");
  expect((await projectView(kernel)).goal).toBe("Ship version 3.");
  expect((await editProject(kernel, { goal: 3 })).status).toBe(400);
});

test("starts the coordinator and new threads with the Project's Profile", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);

  const response = await kernel.route()(
    new Request("http://pipoca/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Release",
        repositories: ["https://example.com/app.git"],
        profile: "work",
      }),
    }),
    "projects",
    pedro,
  );

  const { coordinatorId, profileId } = (await response.json()) as ProjectView;

  expect(profileId).toBe("work");
  expect(kernel.session(coordinatorId).profileId).toBe("work");

  const thread = async (input: Record<string, string>): Promise<string> => {
    const started = await kernel
      .tool("start_thread")
      .run(
        { title: "Docs", message: "write docs", ...input },
        { session: kernel.session(coordinatorId), actor: user },
      );

    const id = /as (\S+)\.$/.exec(started.text)?.[1] ?? "";

    return kernel.session(id).profileId;
  };

  expect(await thread({})).toBe("work");
  expect(await thread({ profile: "review" })).toBe("review");

  await editProject(kernel, { profile: "" });

  expect((await projectView(kernel)).profileId).toBeNull();
  expect(await thread({})).toBe("profile-1");
  expect((await editProject(kernel, { profile: 3 })).status).toBe(400);
});

test("lists each Project with its repositories, coordinator state and the threads that need you", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { coordinatorId, threadId } = await startProject(kernel);

  await kernel
    .tool("set_status")
    .run(
      { state: "blocked" },
      { session: kernel.session(threadId), actor: user },
    );

  const started = await kernel
    .tool("start_thread")
    .run(
      { title: "Ask", message: "ask me" },
      { session: kernel.session(coordinatorId), actor: user },
    );

  const asking = /as (\S+)\.$/.exec(started.text)?.[1] ?? "";
  kernel.update(asking, { waiting: true });

  expect(
    (await projectView(kernel)).threads.find(
      ({ sessionId }) => sessionId === asking,
    ),
  ).toMatchObject({ runState: "waiting", workState: "in_progress" });

  const list = await kernel.route()(
    new Request("http://pipoca/projects"),
    "projects",
    pedro,
  );

  expect(await list.json()).toMatchObject([
    {
      name: "Release",
      coordinatorState: "idle",
      repositories: 1,
      threads: 2,
      needsYou: 2,
    },
  ]);
});

test("archives a Project's Sessions with its coordinator and brings back those it archived", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { coordinatorId, threadId } = await startProject(kernel);

  const started = await kernel
    .tool("start_thread")
    .run(
      { title: "Old", message: "old work" },
      { session: kernel.session(coordinatorId), actor: user },
    );

  const oldId = /as (\S+)\.$/.exec(started.text)?.[1] ?? "";
  kernel.context.sessions.archive(oldId);
  await Bun.sleep(5);

  kernel.context.sessions.archive(coordinatorId);

  expect(kernel.session(threadId).archivedAt).not.toBeNull();
  expect((await projectView(kernel)).coordinatorState).toBe("archived");

  kernel.context.sessions.unarchive(coordinatorId);

  expect(kernel.session(threadId).archivedAt).toBeNull();
  expect(kernel.session(oldId).archivedAt).not.toBeNull();
  expect((await projectView(kernel)).coordinatorState).toBe("idle");
});

test("archives and brings back a Project's other Sessions when one of them fails", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { coordinatorId, threadId } = await startProject(kernel);

  const started = await kernel
    .tool("start_thread")
    .run(
      { title: "Docs", message: "write the docs" },
      { session: kernel.session(coordinatorId), actor: user },
    );

  const docsId = /as (\S+)\.$/.exec(started.text)?.[1] ?? "";
  kernel.stuck.add(threadId);

  kernel.context.sessions.archive(coordinatorId);

  expect(kernel.session(docsId).archivedAt).not.toBeNull();

  expect(kernel.logged).toContainEqual({
    message: "could not archive a Session with its Project",
    fields: { sessionId: threadId, error: `Error: ${threadId} is stuck` },
  });

  kernel.stuck.delete(threadId);
  kernel.context.sessions.archive(threadId);
  kernel.stuck.add(threadId);

  kernel.context.sessions.unarchive(coordinatorId);

  expect(kernel.session(docsId).archivedAt).toBeNull();

  expect(kernel.logged).toContainEqual({
    message: "could not bring back a Session with its Project",
    fields: { sessionId: threadId, error: `Error: ${threadId} is stuck` },
  });
});

test("shows one thread's state and Project for a link to it", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { coordinatorId, threadId } = await startProject(kernel);

  const thread = async (id: string): Promise<Response> =>
    kernel.route()(
      new Request(`http://pipoca/threads/${id}`),
      `threads/${id}`,
      pedro,
    );

  expect(await (await thread(threadId)).json()).toMatchObject({
    sessionId: threadId,
    projectId: (await projectView(kernel)).id,
    runState: "idle",
    workState: "in_progress",
  });

  expect((await thread(coordinatorId)).status).toBe(404);
  expect((await thread("nope")).status).toBe(404);
});

const restored: Partial<Session> = {
  status: "idle",
  error: null,
  archivedAt: null,
  online: true,
};

test("tells the coordinator when a thread can't get its message", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { coordinatorId, threadId } = await startProject(kernel);
  const coordinator = { session: kernel.session(coordinatorId), actor: user };
  const messageThread = kernel.tool("message_thread");

  const refuses = async (
    changes: Partial<Session>,
    error: string,
  ): Promise<void> => {
    kernel.update(threadId, changes);

    const result = await messageThread.run(
      { thread: threadId, text: "stop" },
      coordinator,
    );

    kernel.update(threadId, restored);

    expect(result).toEqual({ text: error, isError: true });
  };

  await refuses(
    { status: "stopped", archivedAt: new Date().toISOString() },
    'thread "Bump version" is archived',
  );

  await refuses(
    { status: "failed", error: "clone failed" },
    'thread "Bump version" failed to start: clone failed',
  );

  await refuses(
    { online: false },
    'thread "Bump version" is on a machine that is offline',
  );

  expect(
    await messageThread.run(
      { thread: threadId, text: "carry on" },
      coordinator,
    ),
  ).toEqual({
    text: 'Message queued for thread "Bump version".',
    isError: false,
  });

  await until(() => kernel.delivered.length > 0);

  expect(kernel.delivered).toEqual([{ kind: "send", text: "carry on" }]);
}, 10_000);

test("tells the coordinator about a thread that stopped mid-turn, not one a restart caught idle", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { threadId } = await startProject(kernel);

  const stopped = (previous: Session["status"], changes: Partial<Session>) => {
    kernel.update(threadId, changes);

    kernel.events.publish({
      type: "SessionStateChanged",
      session: kernel.session(threadId),
      previous,
    });

    kernel.update(threadId, { status: "idle", error: null });
  };

  stopped("idle", { status: "interrupted" });
  stopped("starting", { status: "interrupted" });
  stopped("running", { status: "interrupted" });
  stopped("starting", { status: "failed", error: "clone failed" });

  // Notices go out in the order they were queued, so the failure comes last.
  await until(() =>
    kernel.delivered.some(({ text }) => text.includes("stopped: failed")),
  );

  expect(
    kernel.delivered.map(({ text }) => /\) (stopped: \w+)/.exec(text)?.[1]),
  ).toEqual(["stopped: interrupted", "stopped: failed"]);
}, 10_000);

test("keeps each Project to the person who started it (ADR 0049)", async () => {
  const kernel = fakeKernel();
  projects.register(kernel.context);
  const { threadId } = await startProject(kernel);
  const { id } = await projectView(kernel);
  const ana = fakeUser({ id: "ana" });

  const asAna = async (path: string, body?: unknown): Promise<Response> =>
    kernel.route()(
      new Request(`http://pipoca/${path}`, {
        ...(body !== undefined && {
          method: "POST",
          body: JSON.stringify(body),
        }),
      }),
      path,
      ana,
    );

  expect(await (await asAna("projects")).json()).toEqual([]);

  for (const response of [
    await asAna(`projects/${id}`),
    await asAna(`projects/${id}/settings`, { name: "Mine" }),
    await asAna(`projects/${id}/memory/notes.md`),
    await asAna(`threads/${threadId}`),
    await asAna(`threads/${threadId}/state`, { state: "done" }),
  ]) {
    expect(response.status).toBe(404);
  }

  expect((await projectView(kernel)).name).toBe("Release");
});
