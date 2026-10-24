import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEnvironment } from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";

const failedOutputLines = 20;

// Runs each Environment's setup script once per version of the script and
// its variables on this machine, before the first Session that needs it
// (ADR 0032). A failed run is tried again by the next Session.
export function machineSetup(
  dir: string,
  log: Log,
  signal: AbortSignal,
): (environment: SessionEnvironment) => Promise<void> {
  const running = new Map<string, Promise<void>>();

  return async ({ setupScript, variables }) => {
    if (setupScript.trim() === "") {
      return;
    }

    const version = createHash("sha256")
      .update(
        JSON.stringify([
          setupScript,
          Object.entries(variables).sort(([a], [b]) => a.localeCompare(b)),
        ]),
      )
      .digest("hex");

    const pending =
      running.get(version) ??
      setUp(join(dir, version), setupScript, variables, log, signal).finally(
        () => {
          running.delete(version);
        },
      );

    running.set(version, pending);
    await pending;
  };
}

async function setUp(
  dir: string,
  script: string,
  variables: Readonly<Record<string, string>>,
  log: Log,
  signal: AbortSignal,
): Promise<void> {
  const done = join(dir, "done");
  if (
    await readFile(done).then(
      () => true,
      () => false,
    )
  ) {
    return;
  }

  await mkdir(dir, { recursive: true });

  const outputPath = join(dir, "output.log");
  const started = Date.now();
  log("running setup script", { dir });

  const child = spawn("bash", ["-c", script], {
    cwd: dir,
    env: { ...process.env, ...variables },
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });

  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk));

  // A script that can't start, or stops with the agent, has no exit code.
  const code = await new Promise<number | null>((resolve) => {
    child.once("close", resolve);

    child.once("error", () => {
      resolve(null);
    });
  });

  const text = Buffer.concat(output).toString();
  await writeFile(outputPath, text);

  const durationMs = Date.now() - started;
  if (code !== 0) {
    log("setup script failed", { code, durationMs, output: outputPath });

    // The error is shown to users, who may not see the secrets.
    const tail = Object.values(variables)
      .filter((value) => value.length > 0)
      .reduce((masked, value) => masked.replaceAll(value, "***"), text)
      .trimEnd()
      .split("\n")
      .slice(-failedOutputLines);

    throw new Error(
      `the Environment's setup script exited with code ${String(code)}:\n${tail.join("\n")}`,
    );
  }

  await writeFile(done, new Date().toISOString());
  log("setup script done", { durationMs });
}
