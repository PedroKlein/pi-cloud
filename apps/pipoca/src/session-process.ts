import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { SessionStart } from "@pipoca/protocol";
import type { Log } from "@pipoca/providers";
import {
  type HostedSession,
  hostSession,
  type SessionOptions,
  type TerminalCommand,
} from "@pipoca/sessionhost";
import { httpSessionStream } from "./client";
import { type ContainerSession, serverInContainer } from "./container";
import { stderrLog } from "./log";
import { installedSessionParts, sessionParts } from "./session-parts";

export interface SessionSpec {
  readonly server: string;
  readonly assignment: SessionStart;
  readonly options: Omit<SessionOptions, "models">;
}

type ChildMessage =
  | { readonly type: "ready" }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "terminal"; readonly command: TerminalCommand };

const stopTimeoutMs = 10_000;

// A compiled binary is its own entry point. From source, Bun runs main.ts.
const pipoca = import.meta.dirname.startsWith("/$bunfs")
  ? [process.execPath]
  : [process.execPath, join(import.meta.dirname, "main.ts")];

const sessionCommand = [...pipoca, "session"];

// What the Session's BROWSER runs, from inside its container too.
export const pageOpener = [...pipoca, "open"];

// Runs one Session in a child process (ADR 0017). The child asks the agent to
// open its terminals, since the agent keeps them.
export async function spawnSession(
  spec: SessionSpec,
  log: Log,
  openTerminal: (command: TerminalCommand) => void,
  container?: ContainerSession,
): Promise<HostedSession & { readonly exited: Promise<number | null> }> {
  const [executable = process.execPath, ...args] =
    container?.run ?? sessionCommand;

  // Pi's tools inherit the Environment's variables from the process, and a
  // container gets them from the docker client's.
  const child = spawn(executable, args, {
    env: { ...process.env, ...spec.assignment.environment.variables },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
  });

  await once(child, "spawn");

  const sent = container
    ? { ...spec, server: serverInContainer(spec.server) }
    : spec;

  child.stdin.write(`${JSON.stringify(sent)}\n`);

  log("session process started", {
    pid: child.pid,
    ...(container && { container: container.name }),
  });

  const kill = (): void => {
    child.kill("SIGKILL");
    if (container) {
      const [docker = "docker", ...killArgs] = container.kill;
      spawn(docker, killArgs, { stdio: "ignore" }).on("error", () => undefined);
    }
  };

  const stop = async (): Promise<void> => {
    child.stdin.end();
    const timer = setTimeout(kill, stopTimeoutMs);
    await exited;
    clearTimeout(timer);
  };

  return new Promise((resolve, reject) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = childMessage(line);
      if (message === undefined) {
        log("session process output", { line });
      } else if (message.type === "ready") {
        resolve({ stop, exited });
      } else if (message.type === "failed") {
        reject(new Error(message.error));
      } else {
        openTerminal(message.command);
      }
    });

    void exited.then((code) => {
      reject(new Error(`session process exited with code ${String(code)}`));
    });
  });
}

// Installs a Profile's package in a child process, so git signs in with the
// Session owner's logins without them reaching this process's environment.
// git's own words end the error, since its exit code alone says little.
export async function installPackageApart(
  dir: string,
  source: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const [executable = process.execPath, ...args] = pipoca;

  const child = spawn(executable, [...args, "install-package", dir, source], {
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", process.stderr, "pipe"],
  });

  let errors = "";

  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    errors = (errors + chunk.toString()).slice(-2000);
  });

  const [code] = (await once(child, "close")) as [number | null];

  if (code !== 0) {
    throw new Error(errors.trim() || `exited with code ${String(code)}`);
  }
}

export async function runSessionProcess(): Promise<void> {
  // The agent stops a Session by closing stdin, so SIGTERM here means the
  // whole host is going down, its tools included. Exiting before a killed
  // tool's result is saved leaves the call unanswered, and the reload records
  // it as interrupted rather than as a failed command.
  process.once("SIGTERM", () => {
    process.exit(143);
  });

  const input = createInterface({ input: process.stdin });
  const lines = input[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done === true) {
    return;
  }

  const spec = JSON.parse(first.value) as SessionSpec;
  const { sessionId } = spec.assignment;

  // Parts of Pi, such as its MCP extension, find the agent folder only here.
  process.env["PI_CODING_AGENT_DIR"] = spec.options.agentDir;
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
        ...(await sessionParts(
          spec.assignment,
          installedSessionParts(
            spec.server,
            spec.assignment,
            spec.options.sessionDir,
          ),
        )),
        opener: pageOpener,
      },
      httpSessionStream(spec.server, spec.assignment, log, () => {
        void stop();
      }),
      log,
      (command) => {
        send({ type: "terminal", command });
      },
    );
  } catch (error) {
    send({
      type: "failed",
      error: error instanceof Error ? error.message : String(error),
    });

    process.exit(1);
  }

  send({ type: "ready" });

  // The agent closes stdin to stop the Session, or by exiting.
  while ((await lines.next()).done !== true) {
    // nothing else arrives on stdin
  }

  await stop();
}

function childMessage(line: string): ChildMessage | undefined {
  try {
    const message: unknown = JSON.parse(line);

    return isChildMessage(message) ? message : undefined;
  } catch {
    return undefined;
  }
}

function isChildMessage(value: unknown): value is ChildMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  switch (value.type) {
    case "ready":
      return true;
    case "failed":
      return "error" in value && typeof value.error === "string";
    case "terminal":
      return "command" in value && isTerminalCommand(value.command);
    default:
      return false;
  }
}

function isTerminalCommand(value: unknown): value is TerminalCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    "actor" in value &&
    typeof value.actor === "string" &&
    "type" in value &&
    value.type === "terminal" &&
    "terminalId" in value &&
    typeof value.terminalId === "string" &&
    "cols" in value &&
    typeof value.cols === "number" &&
    "rows" in value &&
    typeof value.rows === "number"
  );
}
