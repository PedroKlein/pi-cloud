import { readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";

// Installs an installed plugin's dependencies and bundles its server part, so
// the part's bare imports resolve from the plugin's own node_modules (ADR
// 0022). Throws with what went wrong.
export async function bundleServerPart(
  folder: string,
  entry: string,
): Promise<string> {
  await installDependencies(folder);

  const outdir = join(folder, ".build");
  await rm(outdir, { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "bun",
    naming: "[name]-[hash].[ext]",
    throw: false,
  });

  const [output] = result.outputs.filter(({ kind }) => kind === "entry-point");

  if (!result.success || output === undefined) {
    throw new Error(
      `${basename(entry)} doesn't build: ${result.logs.map(described).join("\n")}`,
    );
  }

  return output.path;
}

function described(log: BuildMessage | ResolveMessage): string {
  const { position, message } = log;

  return position === null
    ? message
    : `${position.file}:${String(position.line)}:${String(position.column)}: ${message}`;
}

const installTimeoutMs = 2 * 60_000;

async function installDependencies(folder: string): Promise<void> {
  const { dependencies } = JSON.parse(
    await readFile(join(folder, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };

  if (dependencies === undefined || Object.keys(dependencies).length === 0) {
    return;
  }

  // BUN_BE_BUN makes the compiled server act as the bun CLI, so installing
  // needs no npm on the machine. The server waits for this before it
  // listens, so a registry that never answers can't hold it forever, and the
  // plugin's own scripts don't run on every start.
  const install = Bun.spawn([process.execPath, "install", "--ignore-scripts"], {
    cwd: folder,
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdout: "ignore",
    stderr: "pipe",
    timeout: installTimeoutMs,
  });

  const [code, errors] = await Promise.all([
    install.exited,
    new Response(install.stderr).text(),
  ]);

  if (install.signalCode !== null) {
    throw new Error(
      `installing its dependencies took longer than ${String(installTimeoutMs / 60_000)} minutes`,
    );
  }

  if (code !== 0) {
    throw new Error(`installing its dependencies failed: ${errors.trim()}`);
  }
}
