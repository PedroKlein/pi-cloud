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
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { modelLister, startSession, stopSession } from "./session";
import { fauxModels } from "./testdata/models";
import { sessionOptions } from "./testdata/options";

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

test("runs a turn with a tool call and a third-party extension loaded", async () => {
  const { faux, models } = await fauxModels(root);

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("bash", { command: "echo hello from bash" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("done")]),
  ]);

  const session = await startSession(
    sessionOptions(root, { extensionPaths: [subagentsPath], models }),
  );

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
  const { faux, models } = await fauxModels(root);
  faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);
  const sessionDir = join(root, "sessions");

  const session = await startSession(
    sessionOptions(root, { sessionDir, models }),
  );

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

test("starts in the home directory when the path is ~", async () => {
  const { models } = await fauxModels(root);

  const session = await startSession(
    sessionOptions(root, { cwd: "~", models }),
  );

  await stopSession(session);

  expect(session.sessionManager.getCwd()).toBe(homedir());
});

test("fails when an extension does not load", async () => {
  const { models } = await fauxModels(root);
  const broken = join(root, "broken.ts");
  await writeFile(broken, "throw new Error('boom');\n");

  const error: unknown = await startSession(
    sessionOptions(root, { extensionPaths: [broken], models }),
  ).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain(broken);
});

test("continues the session already in the session directory", async () => {
  const { faux, models } = await fauxModels(root);

  faux.setResponses([
    fauxAssistantMessage([fauxText("first")]),
    fauxAssistantMessage([fauxText("second")]),
  ]);

  const options = sessionOptions(root, { models });

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
  const { models } = await fauxModels(root);
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

  const session = await startSession(
    sessionOptions(root, { extensionPaths: [extension], models }),
  );

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

  const session = await startSession(
    sessionOptions(root, {
      agentDir,
      extensionPaths: [await proxyExtension()],
    }),
  );

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

  const session = await startSession(
    sessionOptions(root, {
      agentDir,
      extensionPaths: [await proxyExtension()],
      model: { provider: "proxy", id: "proxy-large" },
    }),
  );

  await stopSession(session);

  expect(modelName(session)).toBe("proxy/proxy-large");
});

test("refuses to start on a model the provider cannot use", async () => {
  const start = startSession(
    sessionOptions(root, {
      extensionPaths: [await proxyExtension()],
      model: { provider: "proxy", id: "proxy-huge" },
    }),
  );

  expect(start).rejects.toThrow("model not available: proxy/proxy-huge");
});

test("keeps a resumed session on the model it last used", async () => {
  const { faux, models } = await fauxModels(root, {
    models: [{ id: "faux-small" }, { id: "faux-large" }],
  });

  const [first, second] = faux.models;
  if (second === undefined) {
    throw new Error("faux has one model");
  }

  faux.setResponses([fauxAssistantMessage("hi")]);

  const options = sessionOptions(root, { models });

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

test("starts a new session at the chosen reasoning level, and a resumed one at its last", async () => {
  const { faux, models } = await fauxModels(root, {
    models: [{ id: "faux-deep", reasoning: true }],
  });

  faux.setResponses([fauxAssistantMessage("hi")]);

  const options = sessionOptions(root, { models });
  const started = await startSession({ ...options, thinking: "high" });
  const chosen = started.thinkingLevel;

  started.setThinkingLevel("low");
  await started.prompt("hello");
  await stopSession(started);

  const resumed = await startSession({ ...options, thinking: "high" });
  await stopSession(resumed);

  expect(chosen).toBe("high");
  expect(resumed.thinkingLevel).toBe("low");
});

test("lists the models Pi can use, with the ones extensions register and later logins", async () => {
  const agentDir = join(root, "agent");

  const list = await modelLister({
    agentDir,
    extensionPaths: [await proxyExtension()],
  });

  const before = await list();
  expect(before).toContainEqual({ provider: "proxy", id: "proxy-small" });
  expect(before).toContainEqual({ provider: "proxy", id: "proxy-large" });
  expect(before.some(({ provider }) => provider === "openai")).toBe(false);

  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }),
  );

  const after = await list();
  expect(after.some(({ provider }) => provider === "openai")).toBe(true);
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
  const { faux, models } = await fauxModels(root);
  faux.setResponses([fauxAssistantMessage([fauxText("sorry")])]);

  const session = await startSession(sessionOptions(root, { models }));

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
  const { faux, models } = await fauxModels(root);
  faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);

  const options = sessionOptions(root, { models });

  const first = await startSession(options);
  await first.prompt("hello");
  await stopSession(first);
  const before = await readFile(String(first.sessionFile), "utf8");
  const second = await startSession(options);
  await stopSession(second);

  expect(await readFile(String(second.sessionFile), "utf8")).toBe(before);
});

test("runs a codemode script, as Pi's CLI does", async () => {
  const { faux, models } = await fauxModels(root);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: "return 6 * 7" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("done")]),
  ]);

  await mkdir(join(root, "agent"));

  await writeFile(
    join(root, "agent", "settings.json"),
    JSON.stringify({ defaultTools: ["+codemode"] }),
  );

  const session = await startSession(sessionOptions(root, { models }));

  const toolOutputs: string[] = [];

  session.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      toolOutputs.push(JSON.stringify(event.result));
    }
  });

  await session.prompt("compute");
  await stopSession(session);

  expect(session.getAllTools().map(({ name }) => name)).toContain(
    "tool_search",
  );

  expect(toolOutputs.join()).toContain("Script completed");
  expect(toolOutputs.join()).toContain("42");
});
