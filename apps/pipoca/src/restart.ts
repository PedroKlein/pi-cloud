import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:os";
import type { Log } from "@pipoca/providers";

// The server exits with this when it restarts, and whatever runs it starts it
// again: systemd's Restart=on-failure, `pipoca server --supervise` in the
// container image, or the dev loop (ADR 0022).
export const restartExitCode = 75;

// Whether something starts the server again when it exits: systemd sets
// INVOCATION_ID, and supervise sets PIPOCA_SUPERVISED.
// Both are taken out of the environment, so a server started inside a
// Session doesn't think it is supervised too.
export function supervised(env: NodeJS.ProcessEnv): boolean {
  const found =
    env["INVOCATION_ID"] !== undefined ||
    env["PIPOCA_SUPERVISED"] !== undefined;

  delete env["INVOCATION_ID"];
  delete env["PIPOCA_SUPERVISED"];

  return found;
}

export interface Supervisor {
  // Sends SIGTERM and resolves with the exit code once the process is gone.
  readonly stop: () => Promise<number>;
  // The code of the first exit that wasn't for a restart, or 128 plus the
  // signal number as a shell reports it.
  readonly exited: Promise<number>;
}

// Runs a pipoca command and starts it again each time it exits with
// restartExitCode, so whatever runs this never sees an exit for a restart.
export function supervise(command: readonly string[], log: Log): Supervisor {
  const [executable = process.execPath, ...args] = command;
  const exited = Promise.withResolvers<number>();
  let stopping = false;

  const run = (): ChildProcess => {
    const started = spawn(executable, args, {
      stdio: "inherit",
      env: { ...process.env, PIPOCA_SUPERVISED: "1" },
    });

    started.once("exit", (code, signal) => {
      if (code === restartExitCode && !stopping) {
        log("restarting", { command: args.join(" ") });
        child = run();

        return;
      }

      exited.resolve(
        code ?? 128 + (signal === null ? 0 : constants.signals[signal]),
      );
    });

    return started;
  };

  let child = run();

  return {
    stop: async () => {
      stopping = true;

      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }

      return exited.promise;
    },
    exited: exited.promise,
  };
}
