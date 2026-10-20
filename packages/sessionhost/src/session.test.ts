import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
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
import {
  type AgentSession,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { listModels, startSession, stopSession } from "./index";

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
  const faux = fauxProvider({
    models: [{ id: "faux-small" }, { id: "faux-large" }],
  });

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

async function proxyExtension(): Promise<string> {
  const extension = join(root, "proxy.ts");

  const model = (id: string): string => `{
        id: "${id}",
        name: "${id}",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      }`;

  await writeFile(
    extension,
    `export default (pi) => {
  pi.registerProvider("proxy", {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "test-key",
    api: "openai-completions",
    models: [${model("proxy-small")}, ${model("proxy-large")}],
  });
};
`,
  );

  return extension;
}

function modelName(session: AgentSession): string {
  return `${String(session.model?.provider)}/${String(session.model?.id)}`;
}

test("uses a default model from a provider an extension registers", async () => {
  const agentDir = join(root, "agent");
  await mkdir(agentDir);

  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "proxy", defaultModel: "proxy-small" }),
  );

  const session = await startSession({
    cwd: root,
    agentDir,
    sessionDir: join(root, "sessions"),
    extensionPaths: [await proxyExtension()],
  });

  await stopSession(session);

  expect(modelName(session)).toBe("proxy/proxy-small");
});

test("starts a new session on the model it asks for", async () => {
  const agentDir = join(root, "agent");
  await mkdir(agentDir);

  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "proxy", defaultModel: "proxy-small" }),
  );

  const session = await startSession({
    cwd: root,
    agentDir,
    sessionDir: join(root, "sessions"),
    extensionPaths: [await proxyExtension()],
    model: { provider: "proxy", id: "proxy-large" },
  });

  await stopSession(session);

  expect(modelName(session)).toBe("proxy/proxy-large");
});

test("refuses to start on a model the provider cannot use", async () => {
  const start = startSession({
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    extensionPaths: [await proxyExtension()],
    model: { provider: "proxy", id: "proxy-huge" },
  });

  expect(start).rejects.toThrow("model not available: proxy/proxy-huge");
});

test("keeps a resumed session on the model it last used", async () => {
  const { faux, runtime } = await fauxModels();
  const [first, second] = faux.models;
  if (second === undefined) {
    throw new Error("faux has one model");
  }

  faux.setResponses([fauxAssistantMessage("hi")]);

  const options = {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    extensionPaths: [],
    models: { runtime, model: first },
  };

  const started = await startSession({
    ...options,
    model: { provider: first.provider, id: first.id },
  });

  await started.setModel(second);
  await started.prompt("hello");
  await stopSession(started);

  const resumed = await startSession({
    ...options,
    model: { provider: first.provider, id: first.id },
  });

  await stopSession(resumed);

  expect(modelName(resumed)).toBe(`${second.provider}/${second.id}`);
});

test("lists the models Pi can use, with the ones extensions register", async () => {
  const models = await listModels({
    agentDir: join(root, "agent"),
    extensionPaths: [await proxyExtension()],
  });

  expect(models).toContainEqual({ provider: "proxy", id: "proxy-small" });
  expect(models).toContainEqual({ provider: "proxy", id: "proxy-large" });
});

test("records an interrupted result for a tool call cut off by a crash", async () => {
  const crashing = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("./testdata/crashing-session.ts")),
      root,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );

  await new Promise<void>((resolve) => {
    crashing.stdout.on("data", (data: Buffer) => {
      if (data.toString().includes("tool started")) {
        resolve();
      }
    });
  });

  crashing.kill("SIGKILL");
  await new Promise((resolve) => crashing.once("exit", resolve));
  const { faux, runtime } = await fauxModels();
  faux.setResponses([fauxAssistantMessage([fauxText("sorry")])]);

  const session = await startSession({
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    extensionPaths: [],
    models: { runtime, model: faux.getModel() },
  });

  await stopSession(session);

  const [call, result] = session.messages.slice(-2);
  expect(call?.role).toBe("assistant");

  expect(result).toMatchObject({
    role: "toolResult",
    toolName: "bash",
    isError: true,
    content: [
      {
        type: "text",
        text: "The tool was interrupted by a restart and may have partly run.",
      },
    ],
  });

  expect(await readFile(String(session.sessionFile), "utf8")).toContain(
    "interrupted by a restart",
  );
}, 30_000);

test("adds nothing when a session stopped between turns", async () => {
  const { faux, runtime } = await fauxModels();
  faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);

  const options = {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    extensionPaths: [],
    models: { runtime, model: faux.getModel() },
  };

  const first = await startSession(options);
  await first.prompt("hello");
  await stopSession(first);
  const before = await readFile(String(first.sessionFile), "utf8");
  const second = await startSession(options);
  await stopSession(second);

  expect(await readFile(String(second.sessionFile), "utf8")).toBe(before);
});
