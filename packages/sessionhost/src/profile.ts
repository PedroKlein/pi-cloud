import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PiPackage, ProfileContent } from "@pi-cloud/protocol";

type Log = (message: string, fields?: Record<string, unknown>) => void;

// The package sources installed so far, so a start installs only new ones.
const installedFile = ".pi-cloud-packages.json";

// Makes a machine's folder for a Profile hold what the server's Profile does
// (ADR 0031). Callers keep two syncs of one folder from overlapping. Pi
// processes of other Sessions may read the folder meanwhile, so packages are
// installed before settings.json lists them, and every file is replaced whole.
export async function syncProfile(
  dir: string,
  profile: ProfileContent,
  log: Log,
): Promise<void> {
  await mkdir(dir, { recursive: true });

  const installed = await installedSources(dir);

  const missing = profile.packages
    .map(sourceOf)
    .filter((source) => !installed.has(source));

  if (missing.length > 0) {
    const packageManager = new DefaultPackageManager({
      cwd: dir,
      agentDir: dir,
      settingsManager: SettingsManager.create(dir, dir),
    });

    for (const source of missing) {
      log("installing profile package", { source });

      await packageManager.install(source).catch((error: unknown) => {
        throw new Error(
          `package ${source} failed to install: ${String(error)}`,
          { cause: error },
        );
      });

      installed.add(source);
      await replace(join(dir, installedFile), JSON.stringify([...installed]));
    }

    log("profile packages installed", { count: missing.length });
  }

  await Promise.all([
    replace(
      join(dir, "settings.json"),
      JSON.stringify({ ...profile.settings, packages: profile.packages }),
    ),
    replace(join(dir, "AGENTS.md"), profile.agentsMd),
    replace(join(dir, "SYSTEM.md"), profile.systemMd),
    replace(join(dir, "APPEND_SYSTEM.md"), profile.appendSystemMd),
    replace(
      join(dir, "mcp.json"),
      Object.keys(profile.mcpServers).length === 0
        ? ""
        : JSON.stringify({ mcpServers: profile.mcpServers }),
    ),
  ]);
}

async function installedSources(dir: string): Promise<Set<string>> {
  const text = await readFile(join(dir, installedFile), "utf8").catch(
    () => "[]",
  );

  const sources: unknown = JSON.parse(text);

  return new Set(
    Array.isArray(sources)
      ? sources.filter((s): s is string => typeof s === "string")
      : [],
  );
}

// An empty text removes the file. Otherwise the new file replaces the old one
// in one rename, so a reader never sees it half written.
async function replace(path: string, text: string): Promise<void> {
  if (text === "") {
    await rm(path, { force: true });

    return;
  }

  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

function sourceOf(pkg: PiPackage): string {
  return typeof pkg === "string" ? pkg : pkg.source;
}
