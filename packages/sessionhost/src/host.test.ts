import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { Command, LiveEvent } from "@pi-cloud/protocol";
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
  options: { failUploads?: number; failPublishes?: number } = {},
): {
  stream: SessionStream;
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
  };

  return {
    stream,
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

  fake.send({ type: "message", text: "hello" });
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

  fake.send({ type: "message", text: "hello" });
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
  first.send({ type: "message", text: "hello" });
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

  fake.send({ type: "terminal", terminalId: "t1", cols: 80, rows: 24 });
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

  fake.send({ type: "message", text: "ship it" });
  await fake.waitFor(() => fake.events.some((e) => e.type === "prompt"));
  const prompt = fake.events.find((e) => e.type === "prompt");
  const id = prompt?.type === "prompt" ? prompt.prompt.id : "";
  fake.send({ type: "answer", id, value: true });
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

  fake.send({ type: "message", text: "ship it" });
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

  fake.send({ type: "terminal", terminalId: "t1", cols: 80, rows: 24 });
  fake.send({ type: "message", text: "hello" });
  await fake.waitFor(() => fake.lines.join().includes("still here"));
  await hosted.stop();

  expect(fake.terminals.get("t1")?.closed).toBe(true);
  expect(logs).toContain("terminal failed to start");
});
