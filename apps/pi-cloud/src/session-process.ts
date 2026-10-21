import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Assignment } from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";
import {
  type HostedSession,
  hostSession,
  type SessionOptions,
  type TerminalCommand,
} from "@pi-cloud/sessionhost";
import { httpSessionStream } from "./client";
import { stderrLog } from "./log";
import { sessionPluginsNamed } from "./plugins";

export interface SessionSpec {
  readonly server: string;
  readonly provider: string;
  readonly assignment: Assignment;
  readonly options: Omit<SessionOptions, "models">;
}

type ChildMessage =
  | { readonly ready: true }
  | { readonly error: string }
  | { readonly terminal: TerminalCommand };

const stopTimeoutMs = 10_000;

// A compiled binary is its own entry point. From source, Bun runs main.ts.
const sessionCommand = import.meta.dirname.startsWith("/$bunfs")
  ? [process.execPath, "session"]
  : [process.execPath, join(import.meta.dirname, "main.ts"), "session"];

// Runs one Session in a child process (ADR 0017). The child asks the agent to
// open its terminals, since the agent keeps them.
export async function spawnSession(
  spec: SessionSpec,
  log: Log,
  openTerminal: (command: TerminalCommand) => void,
): Promise<HostedSession & { readonly exited: Promise<number | null> }> {
  const [executable = process.execPath, ...args] = sessionCommand;

  const child = spawn(executable, args, {
    stdio: ["pipe", "pipe", "inherit"],
  });

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
  });

  child.stdin.write(`${JSON.stringify(spec)}\n`);
  log("session process started", { pid: child.pid });

  const stop = async (): Promise<void> => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), stopTimeoutMs);
    await exited;
    clearTimeout(timer);
  };

  return new Promise((resolve, reject) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = childMessage(line);
      if (message === undefined) {
        log("session process output", { line });
      } else if ("ready" in message) {
        resolve({ stop, exited });
      } else if ("error" in message) {
        reject(new Error(message.error));
      } else {
        openTerminal(message.terminal);
      }
    });

    void exited.then((code) => {
      reject(new Error(`session process exited with code ${String(code)}`));
    });
  });
}

export async function runSessionProcess(): Promise<void> {
  const input = createInterface({ input: process.stdin });
  const lines = input[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done === true) {
    return;
  }

  const spec = JSON.parse(first.value) as SessionSpec;
  const { sessionId } = spec.assignment;
  const base = stderrLog("session");

  const log: Log = (message, fields) => {
    base(message, { sessionId, ...fields });
  };

  const send = (message: ChildMessage): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  let hosted: HostedSession | undefined;
  let stopping: Promise<never> | undefined;

  const stop = async (): Promise<never> => {
    stopping ??= (async () => {
      await hosted?.stop();
      log("session process stopped");
      process.exit(0);
    })();

    return stopping;
  };

  try {
    hosted = await hostSession(
      {
        ...spec.options,
        firstMessage: spec.assignment.firstMessage,
        plugins: sessionPluginsNamed(spec.assignment.plugins),
      },
      httpSessionStream(spec, spec.assignment, log, () => {
        void stop();
      }),
      log,
      (terminal) => {
        send({ terminal });
      },
    );
  } catch (error) {
    send({ error: String(error) });
    process.exit(1);
  }

  send({ ready: true });

  // The agent closes stdin to stop the Session, or by exiting.
  while ((await lines.next()).done !== true) {
    // nothing else arrives on stdin
  }

  await stop();
}

function childMessage(line: string): ChildMessage | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown> | null;

    return parsed !== null &&
      typeof parsed === "object" &&
      ("ready" in parsed || "error" in parsed || "terminal" in parsed)
      ? (parsed as ChildMessage)
      : undefined;
  } catch {
    return undefined;
  }
}
