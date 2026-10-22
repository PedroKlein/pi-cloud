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
  defineTool,
  type ExtensionAPI,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { SessionPlugin } from "@pi-cloud/plugins";
import type { Command, LiveEvent, ToolSpec } from "@pi-cloud/protocol";
import { ask } from "@pi-cloud/ask/session";
import {
  type CheckoutChanges,
  changes,
  type PullRequest,
} from "@pi-cloud/changes/session";
import { hostSession, type SessionStream, type TerminalPeer } from "./index";
import { fauxModels } from "./testdata/models";

let root: string;

// What the composer's menus list, published at every start.
const listings: readonly LiveEvent["type"][] = ["commands", "files"];

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
    pluginRequest: async (plugin, path, init) =>
      Promise.resolve(
        Response.json({ plugin, path, body: init?.body ?? null }),
      ),
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

test("tells clients when the first message cannot be sent to the model", async () => {
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
  const logs: string[] = [];
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
        firstMessage: "kick off",
      },
      fake.stream,
      (message) => logs.push(message),
    );

    await fake.waitFor(() => logs.includes("first message failed"));
    await hosted.stop();
  } finally {
    if (apiKey !== undefined) {
      process.env["OPENAI_API_KEY"] = apiKey;
    }
  }

  const notice = fake.events.find((e) => e.type === "notify");

  expect(notice).toMatchObject({ type: "notify", level: "error" });
  expect(notice?.message).toStartWith("first message failed: ");
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

  expect(fake.events.filter((e) => !listings.includes(e.type))).toEqual([
    { type: "status", status: "idle" },
  ]);

  expect(fake.events.some((e) => e.type === "commands")).toBe(true);
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

  expect(
    fake.events.filter(
      (e) => e.type !== "status" && !listings.includes(e.type),
    ),
  ).toEqual([
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

test("fails an extension's custom terminal dialog with an error it can read", async () => {
  const { faux, models } = await fauxModels(root);
  const extension = join(root, "custom-dialog.ts");

  await writeFile(
    extension,
    `import { Type } from "typebox";
export default (pi) => {
  pi.registerTool({
    name: "pick",
    label: "Pick",
    description: "Shows a terminal dialog",
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _update, ctx) => {
      await ctx.ui.custom(() => ({ render: () => [], invalidate: () => undefined }));
      return { content: [{ type: "text", text: "picked" }], details: {} };
    },
  });
};
`,
  );

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("pick", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);

  const fake = fakeStream();

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

  fake.send({ actor: "user:local", type: "message", text: "pick" });
  await fake.waitFor(() => fake.lines.join().includes('"done"'));
  await hosted.stop();

  expect(fake.lines.join()).toContain("can't show custom terminal dialogs");
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

  expect(
    fake.events.filter(
      (e) => e.type !== "status" && !listings.includes(e.type),
    ),
  ).toEqual([
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

test("asks structured questions with the ask plugin's ask_user tool", async () => {
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
      plugins: [ask],
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

// Pi Cloud's web UI can't draw a terminal extension's custom() dialog, so
// the built-in form must replace a user's own ask_user.
test("replaces a user's own ask_user extension with the web form", async () => {
  const { faux, models } = await fauxModels(root);
  const extension = join(root, "own-ask.ts");

  await writeFile(
    extension,
    `import { Type } from "typebox";
export default (pi) => {
  pi.registerTool({
    name: "ask_user",
    label: "Ask",
    description: "The user's own ask_user",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "asked my way" }], details: {} }),
  });
};
`,
  );

  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("ask_user", {
          questions: [
            {
              id: "color",
              prompt: "Which color?",
              type: "single",
              options: [{ value: "red", label: "Red" }],
            },
          ],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("done")]),
  ]);

  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [extension],
      models,
      plugins: [ask],
    },
    fake.stream,
    () => undefined,
  );

  fake.send({ actor: "user:local", type: "message", text: "ask me" });

  await fake.waitFor(() =>
    fake.events.some(
      (e) => e.type === "prompt" && e.prompt.kind === "questions",
    ),
  );

  const prompt = fake.events.find((e) => e.type === "prompt");

  fake.send({
    actor: "user:local",
    type: "answer",
    id: prompt?.type === "prompt" ? prompt.prompt.id : "",
    value: null,
  });

  await fake.waitFor(() => fake.lines.join().includes('"done"'));
  await hosted.stop();

  expect(fake.lines.join()).not.toContain("asked my way");
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
      plugins: [ask],
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
        plugins: [ask],
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

function published(
  events: readonly LiveEvent[],
): (readonly CheckoutChanges[])[] {
  return events.flatMap((event) =>
    event.type === "plugin" &&
    event.plugin === "changes" &&
    event.key === "changes"
      ? [event.data as readonly CheckoutChanges[]]
      : [],
  );
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
      plugins: [changes],
      checkouts: [{ path: repo, base: null }],
    },
    fake.stream,
    () => undefined,
  );

  await fake.waitFor(() => published(fake.events).length === 1);
  fake.send({ actor: "user:local", type: "message", text: "write notes" });
  await fake.waitFor(() => published(fake.events).length === 2);
  await hosted.stop();

  const [before, after] = published(fake.events).map(([only]) => only);

  expect(before).toMatchObject({
    files: [],
    patch: "",
    truncated: false,
  });

  expect(after).toMatchObject({
    files: [{ status: "A", path: "notes.txt" }],
    truncated: false,
  });

  expect(after?.patch).toContain("+new notes");
  expect(after?.stat).toContain("notes.txt");

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
      plugins: [changes],
      checkouts: [{ path: repo, base: null }],
    },
    fake.stream,
    () => undefined,
  );

  await fake.waitFor(() => published(fake.events).length > 0);
  await hosted.stop();

  expect(published(fake.events)[0]?.[0]).toMatchObject({
    files: [{ status: "A", path: "big.txt" }],
    patch: "",
    truncated: true,
  });
});

// A session branch on a clone whose origin looks like GitHub but is a bare
// repository under root, and a gh on PATH that answers with reply.
async function pullRequestSetup(reply: string): Promise<{
  readonly repo: string;
  readonly base: string;
  readonly ghCalls: string;
  readonly remoteLog: () => Promise<string>;
  readonly restore: () => void;
}> {
  const exec = promisify(execFile);
  const repo = await gitRepository();
  const remote = join(root, "widgets.git");
  const bin = join(root, "bin");
  const ghCalls = join(root, "gh-calls");

  const git = async (...args: string[]): Promise<string> =>
    (await exec("git", args, { cwd: repo })).stdout.trim();

  await exec("git", ["init", "--bare", "--initial-branch=main", remote]);

  await git(
    "config",
    `url.${remote}.insteadOf`,
    "https://github.com/acme/widgets.git",
  );

  await git("remote", "add", "origin", "https://github.com/acme/widgets.git");
  await git("push", "--quiet", "origin", "main");
  await git("switch", "--quiet", "-c", "pi/notes");

  await mkdir(bin);

  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${ghCalls}\n${reply}\n`,
    { mode: 0o755 },
  );

  const saved = { ...process.env };

  Object.assign(process.env, {
    PATH: `${bin}:${saved["PATH"] ?? ""}`,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  });

  return {
    repo,
    base: await git("rev-parse", "HEAD"),
    ghCalls,
    remoteLog: async () =>
      (
        await exec("git", ["log", "--format=%s", "pi/notes"], { cwd: remote })
      ).stdout.trim(),
    restore: () => {
      process.env = saved;
    },
  };
}

function pullRequests(events: readonly LiveEvent[]): PullRequest[] {
  return events.flatMap((event) =>
    event.type === "plugin" &&
    event.plugin === "changes" &&
    event.key === "pull-requests"
      ? (event.data as PullRequest[])
      : [],
  );
}

test("/pr draft commits, pushes and opens a draft pull request that the next start shows", async () => {
  const { faux, models } = await fauxModels(root);

  const setup = await pullRequestSetup(
    "echo https://github.com/acme/widgets/pull/7",
  );

  try {
    await writeFile(join(setup.repo, "notes.txt"), "new notes\n");

    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Add release notes\n\nWrites notes.txt for the release."),
      ]),
    ]);

    const options = {
      cwd: setup.repo,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
      plugins: [changes],
      checkouts: [{ path: setup.repo, base: setup.base }],
    };

    const fake = fakeStream();
    const hosted = await hostSession(options, fake.stream, () => undefined);

    fake.send({ actor: "user:local", type: "message", text: "/pr draft" });

    await fake.waitFor(() =>
      pullRequests(fake.events).some(({ status }) => status === "open"),
    );

    await hosted.stop();

    expect(pullRequests(fake.events)).toEqual([
      { name: "", status: "working" },
      {
        name: "",
        status: "open",
        url: "https://github.com/acme/widgets/pull/7",
      },
    ]);

    expect(await setup.remoteLog()).toBe("Add release notes\nfirst");

    const calls = (await Bun.file(setup.ghCalls).text()).split("\n");
    expect(calls).toContain("--draft");
    expect(calls).toContain("Add release notes");
    expect(calls).toContain("Writes notes.txt for the release.");

    const again = fakeStream();
    const restarted = await hostSession(options, again.stream, () => undefined);
    await again.waitFor(() => pullRequests(again.events).length > 0);
    await restarted.stop();

    expect(pullRequests(again.events)).toEqual([
      {
        name: "",
        status: "open",
        url: "https://github.com/acme/widgets/pull/7",
      },
    ]);
  } finally {
    setup.restore();
  }
});

test("/pr falls back to GitHub's compose page when gh fails", async () => {
  const { faux, models } = await fauxModels(root);
  const setup = await pullRequestSetup("echo 'not logged in' >&2; exit 1");

  try {
    await writeFile(join(setup.repo, "notes.txt"), "new notes\n");
    faux.setResponses([fauxAssistantMessage([fauxText("Add notes\n\nWhy.")])]);

    const fake = fakeStream();

    const hosted = await hostSession(
      {
        cwd: setup.repo,
        agentDir: join(root, "agent"),
        sessionDir: join(root, "sessions"),
        extensionPaths: [],
        models,
        plugins: [changes],
        checkouts: [{ path: setup.repo, base: setup.base }],
      },
      fake.stream,
      () => undefined,
    );

    fake.send({ actor: "user:local", type: "message", text: "/pr" });

    await fake.waitFor(() =>
      pullRequests(fake.events).some(({ status }) => status === "compose"),
    );

    await hosted.stop();

    const last = pullRequests(fake.events).at(-1);

    expect(last).toMatchObject({
      status: "compose",
      reason: "gh pr create failed: not logged in",
    });

    const url = new URL(last?.status === "compose" ? last.url : "");
    expect(url.pathname).toBe("/acme/widgets/compare/pi%2Fnotes");
    expect(url.searchParams.get("title")).toBe("Add notes");
    expect(url.searchParams.get("body")).toBe("Why.");
    expect(await setup.remoteLog()).toBe("Add notes\nfirst");
  } finally {
    setup.restore();
  }
});

test("/pr says why when the branch has nothing to push", async () => {
  const { models } = await fauxModels(root);
  const setup = await pullRequestSetup("exit 1");

  try {
    const fake = fakeStream();

    const hosted = await hostSession(
      {
        cwd: setup.repo,
        agentDir: join(root, "agent"),
        sessionDir: join(root, "sessions"),
        extensionPaths: [],
        models,
        plugins: [changes],
        checkouts: [{ path: setup.repo, base: setup.base }],
      },
      fake.stream,
      () => undefined,
    );

    fake.send({ actor: "user:local", type: "message", text: "/pr compose" });

    await fake.waitFor(() =>
      pullRequests(fake.events).some(({ status }) => status === "failed"),
    );

    await hosted.stop();

    expect(pullRequests(fake.events).at(-1)).toEqual({
      name: "",
      status: "failed",
      error: "nothing to push: the branch has no changes yet",
    });
  } finally {
    setup.restore();
  }
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
      plugins: [changes],
      checkouts: [{ path: root, base: null }],
    },
    fake.stream,
    (message) => logs.push(message),
  );

  await hosted.stop();

  expect(published(fake.events)).toEqual([]);
  expect(logs).not.toContain("workspace changes failed");
});

// Pi writes a session file once it has an assistant message, so the context
// follows a first turn here.
test("adds context to the session without starting a turn", async () => {
  const { faux, models } = await fauxModels(root);
  faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
      firstMessage: null,
    },
    fake.stream,
    () => undefined,
  );

  fake.send({ actor: "user:local", type: "message", text: "hi" });
  await fake.waitFor(() => roles(fake.lines).includes("assistant"));

  const turns = fake.events.filter(
    (e) => e.type === "status" && e.status === "running",
  ).length;

  fake.send({
    actor: "plugin:test",
    type: "context",
    text: "a thread finished",
  });

  await fake.waitFor(() => fake.lines.join().includes("a thread finished"));
  await hosted.stop();

  expect(
    fake.events.filter((e) => e.type === "status" && e.status === "running"),
  ).toHaveLength(turns);

  expect(roles(fake.lines)).toEqual(["system", "user", "assistant"]);
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

test("lets a plugin's tools reach its own server routes", async () => {
  const { faux, models } = await fauxModels(root);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("done")]),
  ]);

  const echo: SessionPlugin = {
    name: "echo",
    tools: async ({ request }) =>
      (await request("member")).ok
        ? [
            defineTool({
              name: "echo",
              label: "Echo",
              description: "Sends text to the plugin's server routes",
              parameters: Type.Object({ text: Type.String() }),
              async execute(_id, params) {
                const response = await request("echo", {
                  method: "PUT",
                  body: params.text,
                });

                return {
                  content: [{ type: "text", text: await response.text() }],
                  details: undefined,
                };
              },
            }),
          ]
        : [],
  };

  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
      plugins: [echo],
    },
    fake.stream,
    () => undefined,
  );

  fake.send({ actor: "user:local", type: "message", text: "echo hi" });
  await fake.waitFor(() => fake.lines.join().includes("done"));
  await hosted.stop();

  expect(fake.lines.join()).toContain(
    JSON.stringify(
      JSON.stringify({ plugin: "echo", path: "echo", body: "hi" }),
    ).slice(1, -1),
  );
});

test("starts with its first message, its system prompt text and plugins' extensions", async () => {
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
    plugins: [
      {
        name: "tooly",
        extension: () => (pi: ExtensionAPI) => {
          pi.on("session_start", () => {
            pi.sendMessage({
              customType: "snapshot",
              content: "notes an extension restores",
              display: false,
            });
          });

          pi.registerTool({
            name: "plugin_tool",
            label: "Plugin tool",
            description: "A tool from a plugin's session part",
            parameters: Type.Object({}),
            execute: async () => Promise.resolve({ content: [], details: {} }),
          });
        },
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

function filesOf(events: readonly LiveEvent[]): readonly string[] | undefined {
  const last = events.findLast((e) => e.type === "files");

  return last?.type === "files" ? last.paths : undefined;
}

test("lists a checkout's tracked and untracked files for mentions, and again after a turn", async () => {
  const { faux, models } = await fauxModels(root);
  const work = join(root, "work");
  await mkdir(join(work, "src"), { recursive: true });
  await writeFile(join(work, ".gitignore"), "dist/\n");
  await writeFile(join(work, "src", "main.ts"), "main\n");
  await mkdir(join(work, "dist"));
  await writeFile(join(work, "dist", "out.js"), "out\n");
  await promisify(execFile)("git", ["init", "--quiet"], { cwd: work });
  await promisify(execFile)("git", ["add", "src"], { cwd: work });
  await writeFile(join(work, "notes.md"), "notes\n");

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("write", { path: "added.txt", content: "new\n" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("done")]),
  ]);

  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: work,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    () => undefined,
  );

  await fake.waitFor(() => filesOf(fake.events) !== undefined);

  expect(fake.events.find((e) => e.type === "files")).toEqual({
    type: "files",
    paths: [".gitignore", "notes.md", "src/main.ts"],
    truncated: false,
  });

  fake.send({ actor: "user:local", type: "message", text: "add a file" });

  await fake.waitFor(
    () => filesOf(fake.events)?.includes("added.txt") ?? false,
  );

  await hosted.stop();

  expect(filesOf(fake.events)).toEqual([
    ".gitignore",
    "added.txt",
    "notes.md",
    "src/main.ts",
  ]);
});

test("walks a folder outside git for mentions, skipping hidden folders and node_modules", async () => {
  const { models } = await fauxModels(root);
  const work = join(root, "work");
  await mkdir(join(work, "lib"), { recursive: true });
  await mkdir(join(work, "node_modules", "dep"), { recursive: true });
  await mkdir(join(work, ".cache"), { recursive: true });
  await writeFile(join(work, "lib", "a.ts"), "a\n");
  await writeFile(join(work, "readme.md"), "r\n");
  await writeFile(join(work, "node_modules", "dep", "index.js"), "d\n");
  await writeFile(join(work, ".cache", "x"), "x\n");

  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: work,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    () => undefined,
  );

  await fake.waitFor(() => filesOf(fake.events) !== undefined);
  await hosted.stop();

  expect(filesOf(fake.events)).toEqual(["lib/a.ts", "readme.md"]);
});
