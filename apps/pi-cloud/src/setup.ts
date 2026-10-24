import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEnvironment } from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";

const failedOutputLines = 20;

// Runs each Environment's setup script once per version on this machine,
// before the first Session that needs it (ADR 0032). A failed run is tried
// again by the next Session.
export function machineSetup(
  dir: string,
  log: Log,
): (environment: SessionEnvironment) => Promise<void> {
  const running = new Map<string, Promise<void>>();

  return async ({ setupScript, variables }) => {
    if (setupScript.trim() === "") {
      return;
    }

    const version = createHash("sha256").update(setupScript).digest("hex");

    const pending =
      running.get(version) ??
      setUp(join(dir, version), setupScript, variables, log).finally(() => {
        running.delete(version);
      });

    running.set(version, pending);
    await pending;
  };
}

async function setUp(
  dir: string,
  script: string,
  variables: Readonly<Record<string, string>>,
  log: Log,
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
  });

  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk));

  const [code] = (await once(child, "close")) as [number | null];
  const text = Buffer.concat(output).toString();
  await writeFile(outputPath, text);

  const durationMs = Date.now() - started;
  if (code !== 0) {
    log("setup script failed", { code, durationMs, output: outputPath });

    const tail = text.trimEnd().split("\n").slice(-failedOutputLines);

    throw new Error(
      `the Environment's setup script exited with code ${String(code)}:\n${tail.join("\n")}`,
    );
  }

  await writeFile(done, new Date().toISOString());
  log("setup script done", { durationMs });
}
