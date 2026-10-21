import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Command, LiveEvent, ToolSpec } from "@pi-cloud/protocol";
import { hostSession, type SessionStream, type TerminalPeer } from "./index";
import { fauxModels } from "./testdata/models";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sessionhost-host-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeStream(
  options: {
    failUploads?: number;
    failPublishes?: number;
    tools?: readonly ToolSpec[];
  } = {},
): {
  stream: SessionStream;
  toolCalls: { id: string; name: string; input: unknown }[];
  send: (command: Command) => void;
  events: LiveEvent[];
  lines: string[];
  uploads: number[];
  terminals: Map<
    string,
    { peer: TerminalPeer; output: string[]; closed: boolean }
  >;
  waitFor: (predicate: () => boolean) => Promise<void>;
} {
  const terminals = new Map<
    string,
    { peer: TerminalPeer; output: string[]; closed: boolean }
  >();

  let failures = options.failUploads ?? 0;
  let publishFailures = options.failPublishes ?? 0;
  let listener: ((command: Command) => void) | undefined;
  const events: LiveEvent[] = [];
  const lines: string[] = [];
  const uploads: number[] = [];
  const toolCalls: { id: string; name: string; input: unknown }[] = [];

  const stream: SessionStream = {
    uploadTranscript: async (start, batch) => {
      await Promise.resolve();
      uploads.push(start);
      if (failures > 0) {
        failures--;
        throw new Error("server unavailable");
      }

      lines.splice(start, batch.length, ...batch);

      return lines.length;
    },
    publish: async (batch) => {
      await Promise.resolve();
      if (publishFailures > 0) {
        publishFailures--;
        throw new Error("server unavailable");
      }

      events.push(...batch);
    },
    commands: (l) => {
      listener = l;

      return () => {
        listener = undefined;
      };
    },
    terminal: (terminalId, peer) => {
      const terminal = { peer, output: [] as string[], closed: false };
      terminals.set(terminalId, terminal);
      const decoder = new TextDecoder();

      return {
        send: (data) => {
          terminal.output.push(decoder.decode(data));
        },
        close: () => {
          terminal.closed = true;
        },
      };
    },
    tools: async () => Promise.resolve(options.tools ?? []),
    callTool: async (id, name, input) => {
      await Promise.resolve();
      toolCalls.push({ id, name, input });
    },
  };

  return {
    stream,
    toolCalls,
    send: (command) => listener?.(command),
    events,
    lines,
    uploads,
    terminals,
    waitFor: async (predicate) => {
      while (!predicate()) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

function roles(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const entry = JSON.parse(line) as { message?: { role: string } };

    return entry.message?.role ?? [];
  });
}

test("streams a turn as live events and transcript lines", async () => {
  const { faux, models } = await fauxModels(root);
  faux.setResponses([fauxAssistantMessage([fauxText("hello back")])]);
  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    () => undefined,
  );

  fake.send({ actor: "user:local", type: "message", text: "hello" });
  await fake.waitFor(() => roles(fake.lines).includes("assistant"));
  await hosted.stop();

  const text = fake.events
    .flatMap((e) => (e.type === "text" ? e.delta : []))
    .join("");

  expect(text).toBe("hello back");

  expect(fake.events.filter((e) => e.type === "status")).toEqual([
    { type: "status", status: "idle" },
    { type: "status", status: "running" },
    { type: "status", status: "idle" },
  ]);

  expect(roles(fake.lines).slice(-2)).toEqual(["user", "assistant"]);
});

test("tells clients when a message cannot be sent to the model", async () => {
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  const loggedOut = runtime.getModels().find((m) => m.provider === "openai");
  if (!loggedOut) {
    throw new Error("Pi has no built-in openai model");
  }

  const fake = fakeStream();
  const apiKey = process.env["OPENAI_API_KEY"];
  delete process.env["OPENAI_API_KEY"];

  try {
    const hosted = await hostSession(
      {
        cwd: root,
        agentDir: join(root, "agent"),
        sessionDir: join(root, "sessions"),
        extensionPaths: [],
        models: { runtime, model: loggedOut },
      },
      fake.stream,
      () => undefined,
    );

    fake.send({ actor: "user:local", type: "message", text: "hello" });
    await fake.waitFor(() => fake.events.some((e) => e.type === "notify"));
    await hosted.stop();
  } finally {
    if (apiKey !== undefined) {
      process.env["OPENAI_API_KEY"] = apiKey;
    }
  }

  const notice = fake.events.find((e) => e.type === "notify");

  expect(notice).toMatchObject({ type: "notify", level: "error" });
  expect(notice?.message).toStartWith("message failed: ");
  expect(notice?.message).toContain("No API key");
});

test("resends the transcript from the last acknowledged line after a failure", async () => {
  const { faux, models } = await fauxModels(root);
  faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);
  const fake = fakeStream({ failUploads: 1 });
  const logs: string[] = [];

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    (message) => logs.push(message),
  );

  fake.send({ actor: "user:local", type: "message", text: "hello" });
  await fake.waitFor(() => roles(fake.lines).includes("assistant"));
  await hosted.stop();

  expect(logs).toContain("transcript upload failed");
  expect(fake.uploads[0]).toBe(0);
  expect(fake.uploads[1]).toBe(0);
  expect(roles(fake.lines).slice(-2)).toEqual(["user", "assistant"]);
});

test("keeps the latest status when a live post fails", async () => {
  const { models } = await fauxModels(root);
  const fake = fakeStream({ failPublishes: 1 });
  const logs: string[] = [];

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    (message) => logs.push(message),
  );

  await fake.waitFor(() => fake.events.length > 0);
  await hosted.stop();

  expect(logs).toContain("live events dropped");
  expect(fake.events).toEqual([{ type: "status", status: "idle" }]);
});

test("resends extension status and widgets when a live post fails", async () => {
  const { models } = await fauxModels(root);
  const fake = fakeStream({ failPublishes: 1 });
  const extension = join(root, "status.ts");

  await writeFile(
    extension,
    `export default (pi) => {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("build", "running");
    ctx.ui.setWidget("todo", ["first"]);
    ctx.ui.setTitle("my session");
    ctx.ui.setEditorText("draft");
  });
};
`,
  );

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [extension],
      models,
    },
    fake.stream,
    () => undefined,
  );

  await fake.waitFor(() => fake.events.length > 0);
  await hosted.stop();

  expect(fake.events.filter((e) => e.type !== "status")).toEqual([
    { type: "extension_status", key: "build", text: "running" },
    {
      type: "widget",
      key: "todo",
      lines: ["first"],
      placement: "aboveEditor",
    },
    { type: "title", title: "my session" },
  ]);
});

test("uploads lines the server is missing as soon as it starts", async () => {
  const { faux, models } = await fauxModels(root);
  faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);

  const options = {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    extensionPaths: [],
    models,
  };

  const first = fakeStream();
  const before = await hostSession(options, first.stream, () => undefined);
  first.send({ actor: "user:local", type: "message", text: "hello" });
  await first.waitFor(() => roles(first.lines).includes("assistant"));
  await before.stop();

  const second = fakeStream();
  const after = await hostSession(options, second.stream, () => undefined);
  await second.waitFor(() => second.lines.length === first.lines.length);
  await after.stop();

  expect(second.lines).toEqual(first.lines);
});

test("opens a terminal in the session directory on command", async () => {
  const { models } = await fauxModels(root);
  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    () => undefined,
  );

  fake.send({
    actor: "user:local",
    type: "terminal",
    terminalId: "t1",
    cols: 80,
    rows: 24,
  });

  const terminal = fake.terminals.get("t1");
  terminal?.peer.input(new TextEncoder().encode("pwd; exit\n"));
  await fake.waitFor(() => terminal?.closed === true);
  await hosted.stop();

  expect(terminal?.output.join("")).toContain(root);
});

async function confirmTool(): Promise<string> {
  const path = join(root, "confirm-tool.ts");

  await writeFile(
    path,
    `import { Type } from "typebox";
export default (pi) => {
  pi.registerTool({
    name: "deploy",
    label: "Deploy",
    description: "Deploys after the user confirms",
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _update, ctx) => {
      const confirmed = await ctx.ui.confirm("Deploy?", "This ships to production");
      return { content: [{ type: "text", text: "confirmed: " + confirmed }], details: {} };
    },
  });
};
`,
  );

  return path;
}

test("asks the user through prompt events and waits for the answer", async () => {
  const { faux, models } = await fauxModels(root);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("deploy", {})], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("deployed")]),
  ]);

  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [await confirmTool()],
      models,
    },
    fake.stream,
    () => undefined,
  );

  fake.send({ actor: "user:local", type: "message", text: "ship it" });
  await fake.waitFor(() => fake.events.some((e) => e.type === "prompt"));
  const prompt = fake.events.find((e) => e.type === "prompt");
  const id = prompt?.type === "prompt" ? prompt.prompt.id : "";
  fake.send({ actor: "user:local", type: "answer", id, value: true });
  await fake.waitFor(() => fake.lines.join().includes("deployed"));
  await hosted.stop();

  expect(prompt).toEqual({
    type: "prompt",
    prompt: {
      id,
      kind: "confirm",
      title: "Deploy?",
      message: "This ships to production",
    },
  });

  expect(fake.events).toContainEqual({ type: "prompt_end", id });
  expect(fake.lines.join()).toContain("confirmed: true");
});

test("cancels open prompts when the session stops", async () => {
  const { faux, models } = await fauxModels(root);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("deploy", {})], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("not deployed")]),
  ]);

  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [await confirmTool()],
      models,
    },
    fake.stream,
    () => undefined,
  );

  fake.send({ actor: "user:local", type: "message", text: "ship it" });
  await fake.waitFor(() => fake.events.some((e) => e.type === "prompt"));
  await hosted.stop();

  expect(fake.events.filter((e) => e.type === "prompt_end")).toHaveLength(1);
});

test("closes a terminal that cannot start and keeps taking commands", async () => {
  const { faux, models } = await fauxModels(root);
  faux.setResponses([fauxAssistantMessage([fauxText("still here")])]);
  const fake = fakeStream();
  const logs: string[] = [];
  const cwd = join(root, "work");
  await mkdir(cwd);

  const hosted = await hostSession(
    {
      cwd,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    (message) => logs.push(message),
  );

  await rm(cwd, { recursive: true });

  fake.send({
    actor: "user:local",
    type: "terminal",
    terminalId: "t1",
    cols: 80,
    rows: 24,
  });

  fake.send({ actor: "user:local", type: "message", text: "hello" });
  await fake.waitFor(() => fake.lines.join().includes("still here"));
  await hosted.stop();

  expect(fake.terminals.get("t1")?.closed).toBe(true);
  expect(logs).toContain("terminal failed to start");
});

test("gives extensions Pi's theme to style status text with", async () => {
  const { models } = await fauxModels(root);
  const fake = fakeStream();
  const extension = join(root, "themed.ts");

  await writeFile(
    extension,
    `export default (pi) => {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(ctx.ui.theme.fg("accent", "themed"), "info");
  });
};
`,
  );

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [extension],
      models,
    },
    fake.stream,
    () => undefined,
  );

  await fake.waitFor(() => fake.events.some((e) => e.type === "status"));
  await hosted.stop();

  expect(
    fake.events.some(
      (e) => e.type === "notify" && e.message.includes("themed"),
    ),
  ).toBe(true);
});

test("opens the terminal in the home directory when the path is ~", async () => {
  const { models } = await fauxModels(root);
  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: "~",
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    () => undefined,
  );

  fake.send({
    actor: "user:local",
    type: "terminal",
    terminalId: "t1",
    cols: 80,
    rows: 24,
  });

  await fake.waitFor(() => fake.terminals.has("t1"));
  fake.terminals.get("t1")?.peer.input(new TextEncoder().encode("pwd\n"));

  await fake.waitFor(() =>
    (fake.terminals.get("t1")?.output.join("") ?? "").includes(homedir()),
  );

  await hosted.stop();

  expect(fake.terminals.get("t1")?.output.join("")).toContain(homedir());
});

test("fails to start when the working directory does not exist", async () => {
  const { models } = await fauxModels(root);
  const missing = join(root, "missing");

  const error: unknown = await hostSession(
    {
      cwd: missing,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fakeStream().stream,
    () => undefined,
  ).catch((e: unknown) => e);

  expect(String(error)).toContain(`working directory not found: ${missing}`);
});

test("logs errors thrown by extension handlers", async () => {
  const { models } = await fauxModels(root);
  const extension = join(root, "throws.ts");
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];

  await writeFile(
    extension,
    `export default (pi) => {
  pi.on("session_start", () => {
    throw new Error("status bar broke");
  });
};
`,
  );

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [extension],
      models,
    },
    fakeStream().stream,
    (message, fields) => logs.push({ message, ...(fields && { fields }) }),
  );

  await hosted.stop();

  expect(logs).toContainEqual({
    message: "extension error",
    fields: {
      extension,
      event: "session_start",
      error: "status bar broke",
    },
  });
});

test("forwards extension status, widgets, title and editor text", async () => {
  const { models } = await fauxModels(root);
  const fake = fakeStream();
  const extension = join(root, "surfaces.ts");

  await writeFile(
    extension,
    `export default (pi) => {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("build", ctx.ui.theme.fg("accent", "2 running"));
    ctx.ui.setWidget("todo", ["first", "second"]);
    ctx.ui.setWidget("hint", ["below"], { placement: "belowEditor" });
    ctx.ui.setWidget("drawn", () => ({ render: () => [], invalidate: () => {} }));
    ctx.ui.setStatus("build", undefined);
    ctx.ui.setTitle("my session");
    ctx.ui.setEditorText("draft");
  });
};
`,
  );

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [extension],
      models,
    },
    fake.stream,
    () => undefined,
  );

  await fake.waitFor(() => fake.events.some((e) => e.type === "editor_text"));
  await hosted.stop();

  expect(fake.events.filter((e) => e.type !== "status")).toEqual([
    { type: "extension_status", key: "build", text: "2 running" },
    {
      type: "widget",
      key: "todo",
      lines: ["first", "second"],
      placement: "aboveEditor",
    },
    {
      type: "widget",
      key: "hint",
      lines: ["below"],
      placement: "belowEditor",
    },
    { type: "extension_status", key: "build", text: null },
    { type: "title", title: "my session" },
    { type: "editor_text", text: "draft" },
  ]);
});

test("asks structured questions with the built-in ask_user tool", async () => {
  const { faux, models } = await fauxModels(root);

  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("ask_user", {
          questions: [
            {
              id: "db",
              prompt: "Which database?",
              type: "single",
              options: [
                {
                  value: "sqlite",
                  label: "SQLite",
                  description: "One file",
                  recommended: true,
                },
                { value: "pg", label: "Postgres" },
              ],
            },
            {
              id: "size",
              label: "Disk",
              prompt: "How much disk?",
              type: "number",
              min: 1,
              max: 100,
              unit: "GB",
            },
            {
              id: "order",
              prompt: "Rank the steps",
              type: "rank",
              options: [
                { value: "lint", label: "Lint" },
                { value: "test", label: "Test" },
              ],
            },
          ],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("noted")]),
  ]);

  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    () => undefined,
  );

  fake.send({ actor: "user:local", type: "message", text: "set it up" });
  await fake.waitFor(() => fake.events.some((e) => e.type === "prompt"));
  const prompt = fake.events.find((e) => e.type === "prompt");
  const id = prompt?.type === "prompt" ? prompt.prompt.id : "";

  fake.send({
    actor: "user:local",
    type: "answer",
    id,
    value: {
      answers: [
        {
          id: "db",
          type: "choice",
          selections: [
            {
              value: "sqlite",
              label: "SQLite",
              custom: false,
              annotation: "keep it simple",
            },
          ],
        },
        { id: "size", type: "number", value: 40 },
        {
          id: "order",
          type: "choice",
          selections: [
            { value: "test", label: "Test", custom: false, annotation: null },
            { value: "lint", label: "Lint", custom: false, annotation: null },
          ],
        },
      ],
      note: "no rush",
    },
  });

  await fake.waitFor(() => fake.lines.join().includes("noted"));
  await hosted.stop();

  expect(prompt).toEqual({
    type: "prompt",
    prompt: {
      id,
      kind: "questions",
      title: "Questions from the agent",
      explain: true,
      questions: [
        {
          id: "db",
          label: "Q1",
          prompt: "Which database?",
          context: null,
          type: "single",
          options: [
            {
              value: "sqlite",
              label: "SQLite",
              description: "One file",
              recommended: true,
            },
            {
              value: "pg",
              label: "Postgres",
              description: null,
              recommended: false,
            },
          ],
        },
        {
          id: "size",
          label: "Disk",
          prompt: "How much disk?",
          context: null,
          type: "number",
          min: 1,
          max: 100,
          step: 1,
          unit: "GB",
          recommended: null,
        },
        {
          id: "order",
          label: "Q3",
          prompt: "Rank the steps",
          context: null,
          type: "rank",
          options: [
            {
              value: "lint",
              label: "Lint",
              description: null,
              recommended: false,
            },
            {
              value: "test",
              label: "Test",
              description: null,
              recommended: false,
            },
          ],
        },
      ],
    },
  });

  const result = fake.lines
    .map((line) => JSON.parse(line) as { message?: { role: string } })
    .find((entry) => entry.message?.role === "toolResult");

  expect(JSON.stringify(result)).toContain(
    [
      "User answers:",
      "- Q1: SQLite",
      '    → \\"keep it simple\\"',
      "- Disk: 40 GB",
      "- Q3: 1. Test, 2. Lint",
      "- Additional notes: no rush",
    ].join("\\n"),
  );
});

test("explains an option with the session's model while the form is open", async () => {
  const { faux, models } = await fauxModels(root);

  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("ask_user", {
          questions: [
            {
              id: "db",
              prompt: "Which database?",
              type: "single",
              options: [
                { value: "sqlite", label: "SQLite" },
                { value: "pg", label: "Postgres" },
              ],
            },
          ],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("Postgres needs a server.")]),
    fauxAssistantMessage([fauxText("noted")]),
  ]);

  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    () => undefined,
  );

  fake.send({ actor: "user:local", type: "message", text: "set it up" });
  await fake.waitFor(() => fake.events.some((e) => e.type === "prompt"));
  const prompt = fake.events.find((e) => e.type === "prompt");
  const id = prompt?.type === "prompt" ? prompt.prompt.id : "";

  fake.send({
    actor: "user:local",
    type: "explain",
    id,
    questionId: "db",
    value: "pg",
    question: "Do I need to run it?",
  });

  await fake.waitFor(() => fake.events.some((e) => e.type === "explanation"));
  fake.send({ actor: "user:local", type: "answer", id, value: null });
  await fake.waitFor(() => fake.lines.join().includes("noted"));
  await hosted.stop();

  expect(fake.events.find((e) => e.type === "explanation")).toEqual({
    type: "explanation",
    id,
    questionId: "db",
    value: "pg",
    question: "Do I need to run it?",
    text: "Postgres needs a server.",
    error: null,
  });

  expect(fake.lines.join()).toContain("User cancelled the questionnaire");
});

test.each([
  ["steer", ["user", "assistant", "toolResult", "user", "assistant"]],
  [
    "followUp",
    ["user", "assistant", "toolResult", "assistant", "user", "assistant"],
  ],
] as const)(
  "queues a %s message sent while the session is busy",
  async (delivery, expected) => {
    const { faux, models } = await fauxModels(root);
    await writeFile(join(root, "notes.txt"), "notes");
    let release = (): void => undefined;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    faux.setResponses([
      async () => {
        await gate;

        return fauxAssistantMessage([
          fauxToolCall("read", { path: "notes.txt" }),
        ]);
      },
      fauxAssistantMessage([fauxText("read it")]),
      fauxAssistantMessage([fauxText("queued reply")]),
    ]);

    const fake = fakeStream();

    const hosted = await hostSession(
      {
        cwd: root,
        agentDir: join(root, "agent"),
        sessionDir: join(root, "sessions"),
        extensionPaths: [],
        models,
      },
      fake.stream,
      () => undefined,
    );

    fake.send({ actor: "user:local", type: "message", text: "first" });
    await fake.waitFor(() => faux.state.callCount === 1);

    fake.send({
      actor: "user:local",
      type: "message",
      text: "second",
      delivery,
    });

    await fake.waitFor(() => fake.events.some((e) => e.type === "queue"));
    release();

    await fake.waitFor(
      () =>
        fake.events.at(-1)?.type === "status" &&
        roles(fake.lines).at(-1) === "assistant",
    );

    await hosted.stop();

    expect(fake.events.filter((e) => e.type === "queue")).toEqual([
      {
        type: "queue",
        steering: delivery === "steer" ? ["second"] : [],
        followUp: delivery === "followUp" ? ["second"] : [],
      },
      { type: "queue", steering: [], followUp: [] },
    ]);

    expect(roles(fake.lines).filter((role) => role !== "system")).toEqual([
      ...expected,
    ]);
  },
);

async function gitRepository(): Promise<string> {
  const dir = join(root, "repo");
  await mkdir(dir);

  const git = async (...args: string[]): Promise<void> => {
    await promisify(execFile)("git", args, { cwd: dir });
  };

  await git("init", "--initial-branch=main");
  await writeFile(join(dir, "README.md"), "hello\n");
  await git("add", ".");

  await git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "first",
  );

  return dir;
}

test("publishes what the session changed in its git workspace after a turn", async () => {
  const { faux, models } = await fauxModels(root);
  const repo = await gitRepository();

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: "notes.txt", content: "new notes\n" }),
    ]),
    fauxAssistantMessage([fauxText("wrote it")]),
  ]);

  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: repo,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    () => undefined,
  );

  const changes = (): Extract<LiveEvent, { type: "changes" }>[] =>
    fake.events.filter((e) => e.type === "changes");

  await fake.waitFor(() => changes().length === 1);
  fake.send({ actor: "user:local", type: "message", text: "write notes" });
  await fake.waitFor(() => changes().length === 2);
  await hosted.stop();

  expect(changes()[0]).toMatchObject({
    files: [],
    patch: "",
    truncated: false,
  });

  expect(changes()[1]).toMatchObject({
    files: [{ status: "A", path: "notes.txt" }],
    truncated: false,
  });

  expect(changes()[1]?.patch).toContain("+new notes");
  expect(changes()[1]?.stat).toContain("notes.txt");

  const { stdout } = await promisify(execFile)(
    "git",
    ["status", "--porcelain"],
    { cwd: repo },
  );

  expect(stdout).toBe("?? notes.txt\n");
});

test("sends only the stat when the patch is too large", async () => {
  const { models } = await fauxModels(root);
  const repo = await gitRepository();

  await writeFile(
    join(repo, "big.txt"),
    "x".repeat(100).concat("\n").repeat(5000),
  );

  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: repo,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    () => undefined,
  );

  await fake.waitFor(() => fake.events.some((e) => e.type === "changes"));
  await hosted.stop();

  expect(fake.events.find((e) => e.type === "changes")).toMatchObject({
    files: [{ status: "A", path: "big.txt" }],
    patch: "",
    truncated: true,
  });
});

test("publishes no changes outside a git repository", async () => {
  const { models } = await fauxModels(root);
  const logs: string[] = [];
  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    (message) => logs.push(message),
  );

  await hosted.stop();

  expect(fake.events.some((e) => e.type === "changes")).toBe(false);
  expect(logs).not.toContain("workspace changes failed");
});

test("runs server tools through the stream and gives the model their result", async () => {
  const { faux, models } = await fauxModels(root);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("lookup", { key: "answer" })], {
      stopReason: "toolUse",
    }),
    (context) =>
      fauxAssistantMessage([
        fauxText(
          JSON.stringify(context.messages).includes("forty-two")
            ? "the server said forty-two"
            : "no result",
        ),
      ]),
  ]);

  const fake = fakeStream({
    tools: [
      {
        name: "lookup",
        description: "Looks a key up on the server",
        parameters: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
        },
      },
    ],
  });

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    () => undefined,
  );

  fake.send({ actor: "user:local", type: "message", text: "look it up" });
  await fake.waitFor(() => fake.toolCalls.length > 0);
  const [call] = fake.toolCalls;

  fake.send({
    actor: "plugin:test",
    type: "tool_result",
    id: call?.id ?? "",
    result: { text: "forty-two", isError: false },
  });

  await fake.waitFor(() => fake.lines.join().includes("the server said"));
  await hosted.stop();

  expect(call).toMatchObject({ name: "lookup", input: { key: "answer" } });
  expect(fake.lines.join()).toContain("the server said forty-two");
});

test("starts with its first message, its system prompt text and plugin extensions", async () => {
  const { faux, models } = await fauxModels(root);

  faux.setResponses([fauxAssistantMessage([fauxText("started")])]);

  const options = {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    extensionPaths: [],
    models,
    systemPrompt: "You coordinate project X.",
    firstMessage: "kick off",
    extensions: [
      (pi: ExtensionAPI) => {
        pi.registerTool({
          name: "plugin_tool",
          label: "Plugin tool",
          description: "A tool from a plugin's session part",
          parameters: Type.Object({}),
          execute: async () => Promise.resolve({ content: [], details: {} }),
        });
      },
    ],
  };

  const fake = fakeStream();
  const first = await hostSession(options, fake.stream, () => undefined);
  await fake.waitFor(() => roles(fake.lines).includes("assistant"));
  await first.stop();

  const again = fakeStream();
  const second = await hostSession(options, again.stream, () => undefined);
  await again.waitFor(() => again.lines.length >= fake.lines.length);
  await second.stop();

  const system = fake.lines
    .map((line) => JSON.parse(line) as { message?: { role: string } })
    .find((entry) => entry.message?.role === "system");

  expect(roles(fake.lines)).toEqual(["system", "user", "assistant"]);
  expect(fake.lines.join()).toContain("kick off");
  expect(JSON.stringify(system)).toContain("You coordinate project X.");
  expect(JSON.stringify(system)).toContain('"name":"plugin_tool"');
  expect(roles(again.lines).filter((role) => role === "user")).toHaveLength(1);
});
