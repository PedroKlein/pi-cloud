import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEnvironment } from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";

// Until Pi Cloud publishes its own image: glibc, bash, git and npm.
export const defaultImage = "node:22-bookworm";

const failedOutputLines = 20;

// Runs each Environment's setup script once per version of the script, its
// variables and its image, before the first Session that needs it (ADR 0032).
// A process Session's script runs on this machine. A container Session's
// runs in its image, and the result is kept as an image that the Session then
// runs. A failed run is tried again by the next Session.
export function environmentSetup(
  dir: string,
  log: Log,
  signal: AbortSignal,
): (environment: SessionEnvironment) => Promise<string | undefined> {
  const running = new Map<string, Promise<string | undefined>>();

  return async (environment) => {
    const image =
      environment.isolation === "container"
        ? (environment.image ?? defaultImage)
        : undefined;

    if (environment.setupScript.trim() === "") {
      return image;
    }

    const version = createHash("sha256")
      .update(
        JSON.stringify([
          image ?? null,
          environment.setupScript,
          Object.entries(environment.variables).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ]),
      )
      .digest("hex")
      .slice(0, 32);

    const setUp = async (): Promise<string | undefined> =>
      image === undefined
        ? setUpMachine(join(dir, version), environment, log, signal)
        : setUpImage(image, version, environment, log, signal);

    const pending =
      running.get(version) ??
      setUp().finally(() => {
        running.delete(version);
      });

    running.set(version, pending);

    return pending;
  };
}

async function setUpMachine(
  dir: string,
  { setupScript, variables }: SessionEnvironment,
  log: Log,
  signal: AbortSignal,
): Promise<undefined> {
  const done = join(dir, "done");
  if (
    await readFile(done).then(
      () => true,
      () => false,
    )
  ) {
    return undefined;
  }

  await mkdir(dir, { recursive: true });

  const started = Date.now();
  log("running setup script", { dir });

  const { code, output } = await run(["bash", "-c", setupScript], {
    cwd: dir,
    variables,
    signal,
  });

  const outputPath = join(dir, "output.log");
  await writeFile(outputPath, output);

  const durationMs = Date.now() - started;
  if (code !== 0) {
    log("setup script failed", { code, durationMs, output: outputPath });

    throw setupFailure(code, output, variables);
  }

  await writeFile(done, new Date().toISOString());
  log("setup script done", { durationMs });

  return undefined;
}

// The script runs as the image's own user, usually root, so it can install
// packages. Sessions then run as the runner's user. It runs through docker
// exec, whose variables the commit doesn't keep, so the image holds no
// secrets.
async function setUpImage(
  image: string,
  version: string,
  { setupScript, variables }: SessionEnvironment,
  log: Log,
  signal: AbortSignal,
): Promise<string> {
  const tag = `pi-cloud-setup:${version}`;

  const inspected = await run(["docker", "image", "inspect", tag], { signal });
  if (inspected.code === 0) {
    return tag;
  }

  // Another agent on this Docker may set up the same version at once.
  const container = `pi-cloud-setup-${version}-${randomUUID().slice(0, 8)}`;
  const started = Date.now();
  log("running setup script in image", { image, tag });

  try {
    const created = await run(
      [
        "docker",
        "run",
        "-d",
        "--name",
        container,
        "--entrypoint",
        "sleep",
        image,
        "infinity",
      ],
      { signal },
    );

    if (created.code !== 0) {
      throw new Error(`could not start ${image}: ${created.output}`);
    }

    const { code, output } = await run(
      [
        "docker",
        "exec",
        ...Object.keys(variables).flatMap((name) => ["-e", name]),
        container,
        "bash",
        "-c",
        setupScript,
      ],
      { variables, signal },
    );

    const durationMs = Date.now() - started;
    if (code !== 0) {
      log("setup script failed", { image, code, durationMs });

      throw setupFailure(code, output, variables);
    }

    const committed = await run(["docker", "commit", container, tag], {
      signal,
    });

    if (committed.code !== 0) {
      throw new Error(`could not keep the set-up image: ${committed.output}`);
    }

    log("setup script done", { image, tag, durationMs });

    return tag;
  } finally {
    // Not with the agent's signal, which may be why setup is ending.
    await run(["docker", "rm", "-f", container], {
      signal: new AbortController().signal,
    });
  }
}

function setupFailure(
  code: number | null,
  output: string,
  variables: Readonly<Record<string, string>>,
): Error {
  // The error is shown to users, who may not see the secrets.
  const tail = Object.values(variables)
    .filter((value) => value.length > 0)
    .reduce((masked, value) => masked.replaceAll(value, "***"), output)
    .trimEnd()
    .split("\n")
    .slice(-failedOutputLines);

  return new Error(
    `the Environment's setup script exited with code ${String(code)}:\n${tail.join("\n")}`,
  );
}

async function run(
  [command = "", ...args]: readonly string[],
  options: {
    readonly cwd?: string;
    readonly variables?: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
): Promise<{ readonly code: number | null; readonly output: string }> {
  const child = spawn(command, args, {
    ...(options.cwd !== undefined && { cwd: options.cwd }),
    env: { ...process.env, ...options.variables },
    stdio: ["ignore", "pipe", "pipe"],
    signal: options.signal,
  });

  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk));

  // A command that can't start, or stops with the agent, has no exit code.
  const code = await new Promise<number | null>((resolve) => {
    child.once("close", resolve);

    child.once("error", () => {
      resolve(null);
    });
  });

  return { code, output: Buffer.concat(output).toString() };
}
