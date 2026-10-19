import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { startSession, stopSession } from "./index";

const subagentsPath = dirname(
  fileURLToPath(import.meta.resolve("pi-subagents/package.json")),
);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sessionhost-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fauxModels(): Promise<{
  faux: ReturnType<typeof fauxProvider>;
  runtime: ModelRuntime;
}> {
  const faux = fauxProvider();

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  return { faux, runtime };
}

test("runs a turn with a tool call and a third-party extension loaded", async () => {
  const { faux, runtime } = await fauxModels();

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("bash", { command: "echo hello from bash" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("done")]),
  ]);

  const session = await startSession({
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    extensionPaths: [subagentsPath],
    models: { runtime, model: faux.getModel() },
  });

  const toolOutputs: string[] = [];

  session.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      toolOutputs.push(JSON.stringify(event.result));
    }
  });

  await session.prompt("run something");
  await stopSession(session);

  expect(session.getActiveToolNames()).toContain("subagent");
  expect(toolOutputs.join()).toContain("hello from bash");
  expect(session.getLastAssistantText()).toBe("done");
});

test("writes the transcript as JSONL in the session directory", async () => {
  const { faux, runtime } = await fauxModels();
  faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);
  const sessionDir = join(root, "sessions");

  const session = await startSession({
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir,
    extensionPaths: [],
    models: { runtime, model: faux.getModel() },
  });

  await session.prompt("hello");
  await stopSession(session);

  const files = await readdir(sessionDir);
  expect(files).toHaveLength(1);

  const lines = (await readFile(join(sessionDir, String(files[0])), "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as { type: string; message?: { role: string } },
    );

  expect(lines[0]?.type).toBe("session");

  expect(lines.flatMap((line) => line.message?.role ?? []).slice(-2)).toEqual([
    "user",
    "assistant",
  ]);
});

test("fails when an extension does not load", async () => {
  const { faux, runtime } = await fauxModels();
  const broken = join(root, "broken.ts");
  await writeFile(broken, "throw new Error('boom');\n");

  const error: unknown = await startSession({
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    extensionPaths: [broken],
    models: { runtime, model: faux.getModel() },
  }).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain(broken);
});

test("continues the session already in the session directory", async () => {
  const { faux, runtime } = await fauxModels();

  faux.setResponses([
    fauxAssistantMessage([fauxText("first")]),
    fauxAssistantMessage([fauxText("second")]),
  ]);

  const options = {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    extensionPaths: [],
    models: { runtime, model: faux.getModel() },
  };

  const first = await startSession(options);
  await first.prompt("one");
  await stopSession(first);
  const second = await startSession(options);
  await second.prompt("two");
  await stopSession(second);

  expect(second.sessionFile).toBe(first.sessionFile);

  expect(
    second.messages.map((m) => m.role).filter((role) => role !== "system"),
  ).toEqual(["user", "assistant", "user", "assistant"]);

  expect(await readdir(join(root, "sessions"))).toHaveLength(1);
});

test("starts and stops extensions with session events", async () => {
  const { faux, runtime } = await fauxModels();
  const marker = join(root, "started");
  const extension = join(root, "on-start.ts");

  await writeFile(
    extension,
    `import { appendFileSync } from "node:fs";
export default (pi) => {
  pi.on("session_start", (event) => {
    appendFileSync(${JSON.stringify(marker)}, "start:" + event.reason);
  });
  pi.on("session_shutdown", (event) => {
    appendFileSync(${JSON.stringify(marker)}, " stop:" + event.reason);
  });
};
`,
  );

  const session = await startSession({
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    extensionPaths: [extension],
    models: { runtime, model: faux.getModel() },
  });

  await stopSession(session);

  expect(await readFile(marker, "utf8").catch(() => "")).toBe(
    "start:startup stop:quit",
  );
});

test("uses a default model from a provider an extension registers", async () => {
  const agentDir = join(root, "agent");
  const extension = join(root, "proxy.ts");
  await mkdir(agentDir);

  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "proxy", defaultModel: "proxy-small" }),
  );

  await writeFile(
    extension,
    `export default (pi) => {
  pi.registerProvider("proxy", {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "test-key",
    api: "openai-completions",
    models: [
      {
        id: "proxy-small",
        name: "Proxy small",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      },
    ],
  });
};
`,
  );

  const session = await startSession({
    cwd: root,
    agentDir,
    sessionDir: join(root, "sessions"),
    extensionPaths: [extension],
  });

  await stopSession(session);

  expect(
    `${String(session.model?.provider)}/${String(session.model?.id)}`,
  ).toBe("proxy/proxy-small");
});
