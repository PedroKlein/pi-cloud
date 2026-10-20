import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Session, SessionEvent } from "@pi-cloud/protocol";
import { serve } from "./serve";
import { readSse } from "./sse";

interface AssistantEntry {
  readonly message?: {
    readonly role: string;
    readonly provider?: string;
    readonly model?: string;
    readonly stopReason?: string;
    readonly errorMessage?: string;
    readonly content?: readonly { type: string; text?: string }[];
  };
}

const stepTimeoutMs = 120_000;
const started = performance.now();
const root = await mkdtemp(join(tmpdir(), "pi-cloud-smoke-"));
const cwd = join(root, "work");
await mkdir(cwd);

const server = serve({
  port: 0,
  database: ":memory:",
  log: () => undefined,
});

const agentOutput: string[] = [];

const agent = spawn(
  process.execPath,
  [
    join(import.meta.dirname, "main.ts"),
    "agent",
    "--name",
    "smoke",
    "--server",
    server.url.href,
    "--data-dir",
    join(root, "agent"),
    "--folder",
    cwd,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

for (const output of [agent.stdout, agent.stderr]) {
  createInterface({ input: output }).on("line", (line) => {
    agentOutput.push(line);
  });
}

const agentExited = new Promise((resolve) => agent.once("exit", resolve));
let failures = 0;

function report(ok: boolean, name: string, detail: string): void {
  const seconds = ((performance.now() - started) / 1000).toFixed(1);

  process.stdout.write(
    `${seconds.padStart(6)}s  ${ok ? "ok  " : "FAIL"}  ${name}: ${detail}\n`,
  );
}

async function step(
  name: string,
  run: () => Promise<string>,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(stepTimeoutMs / 1000)}s`));
    }, stepTimeoutMs);
  });

  try {
    report(true, name, await Promise.race([run(), timeout]));

    return true;
  } catch (error) {
    failures++;
    report(false, name, error instanceof Error ? error.message : String(error));

    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function api(path: string, body?: unknown): Promise<Response> {
  const response = await fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    ...(body !== undefined && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });

  if (!response.ok) {
    throw new Error(`${path} returned ${String(response.status)}`);
  }

  return response;
}

function follow(sessionId: string): {
  readonly next: <T>(
    find: (event: SessionEvent) => T | undefined,
  ) => Promise<T>;
  readonly close: () => void;
} {
  const controller = new AbortController();
  const events: SessionEvent[] = [];
  let changed = (): void => undefined;

  void fetch(new URL(`/api/sessions/${sessionId}/events`, server.url), {
    signal: controller.signal,
  })
    .then(async (response) => {
      for await (const event of readSse(response)) {
        events.push(event as SessionEvent);
        changed();
      }
    })
    .catch(() => undefined);

  return {
    next: async (find) => {
      for (;;) {
        for (let e = events.shift(); e !== undefined; e = events.shift()) {
          const found = find(e);
          if (found !== undefined) {
            return found;
          }
        }

        await new Promise<void>((resolve) => {
          changed = resolve;
        });
      }
    },
    close: () => {
      controller.abort();
    },
  };
}

function runningSession(event: SessionEvent): Session | undefined {
  if (event.type !== "session") {
    return undefined;
  }

  if (event.session.status === "failed") {
    throw new Error(event.session.error ?? "session failed");
  }

  return event.session.status === "idle" ? event.session : undefined;
}

function assistantReply(event: SessionEvent): AssistantEntry | undefined {
  if (event.type !== "entry") {
    return undefined;
  }

  const entry = JSON.parse(event.entry) as AssistantEntry;

  return entry.message?.role === "assistant" ? entry : undefined;
}

async function terminalPrints(
  sessionId: string,
  marker: string,
): Promise<void> {
  const url = new URL(
    `/api/sessions/${sessionId}/terminal?cols=80&rows=24`,
    server.url,
  );

  url.protocol = "ws:";
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const decoder = new TextDecoder();
  let text = "";

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send(new TextEncoder().encode(`echo ${marker}-$((40+2))\n`));
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      text += decoder.decode(event.data as ArrayBuffer, { stream: true });
      if (text.includes(`${marker}-42`)) {
        resolve();
      }
    });

    socket.addEventListener("close", (event) => {
      reject(new Error(`terminal closed: ${event.reason || "no reason"}`));
    });
  }).finally(() => {
    socket.close();
  });
}

process.stdout.write(`smoke test in ${cwd} with your Pi setup\n`);

const { id } = (await (
  await api("/api/sessions", {
    provider: "smoke",
    workspace: { kind: "folder", path: cwd },
  })
).json()) as Session;

const events = follow(id);

const sessionStarted = await step("session starts", async () => {
  await events.next(runningSession);

  return `running in ${cwd}`;
});

if (sessionStarted) {
  await step("model replies", async () => {
    await api(`/api/sessions/${id}/commands`, {
      type: "message",
      text: "Reply with the single word pong.",
    });

    const { message } = await events.next(assistantReply);
    const model = `${message?.provider ?? "?"}/${message?.model ?? "?"}`;

    if (message?.stopReason === "error") {
      throw new Error(`${model}: ${message.errorMessage ?? "unknown error"}`);
    }

    const text = (message?.content ?? [])
      .flatMap((part) => part.text ?? [])
      .join("")
      .trim();

    return `${model} said ${JSON.stringify(text.slice(0, 60))}`;
  });

  await step("terminal runs a command", async () => {
    await terminalPrints(id, "smoke");

    return "shell answered";
  });
}

events.close();
agent.kill("SIGTERM");
await agentExited;
await server.stop();
await rm(root, { recursive: true, force: true });

const problems = agentOutput.filter((line) => /error|fail/i.test(line));

if (problems.length === 0) {
  report(
    true,
    "agent output",
    `${String(agentOutput.length)} lines, no errors`,
  );
} else {
  failures++;
  report(false, "agent output", `${String(problems.length)} error lines`);
  process.stdout.write(`${problems.map((line) => `  ${line}`).join("\n")}\n`);
}

process.stdout.write(
  failures === 0 ? "smoke test passed\n" : "smoke test failed\n",
);

process.exit(failures === 0 ? 0 : 1);
