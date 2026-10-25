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
      `${basename(entry)} doesn't build: ${result.logs.map(String).join("\n")}`,
    );
  }

  return output.path;
}

async function installDependencies(folder: string): Promise<void> {
  const { dependencies } = JSON.parse(
    await readFile(join(folder, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };

  if (dependencies === undefined || Object.keys(dependencies).length === 0) {
    return;
  }

  // BUN_BE_BUN makes the compiled server act as the bun CLI, so installing
  // needs no npm on the machine.
  const install = Bun.spawn([process.execPath, "install"], {
    cwd: folder,
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdout: "ignore",
    stderr: "pipe",
  });

  const [code, errors] = await Promise.all([
    install.exited,
    new Response(install.stderr).text(),
  ]);

  if (code !== 0) {
    throw new Error(`installing its dependencies failed: ${errors.trim()}`);
  }
}
