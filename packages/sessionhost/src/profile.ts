import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PiPackage, ProfileFiles } from "@pipoca/protocol";

type Log = (message: string, fields?: Record<string, unknown>) => void;

// The package sources installed so far, so a start installs only new ones.
const installedFile = ".pipoca-packages.json";

// The hash of the Profile files this folder holds, and their paths.
const copyFile = ".pipoca-profile.json";

// What folders written before a Profile was a whole folder held.
const earlierFiles = [
  "settings.json",
  "AGENTS.md",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
  "mcp.json",
];

// Makes a machine's folder for a Profile hold the server's Profile folder
// (ADR 0041). It downloads the files only when their hash differs from its
// copy's. Callers keep two syncs of one folder from overlapping. Pi processes
// of other Sessions may read the folder meanwhile, so packages are installed
// before settings.json lists them, and every file is replaced whole.
export async function syncProfile(
  dir: string,
  hash: string,
  download: () => Promise<ProfileFiles>,
  log: Log,
  install: InstallPackage = installPackage,
): Promise<void> {
  await mkdir(dir, { recursive: true });

  const copy = await copyOf(dir);
  if (copy?.hash === hash) {
    return;
  }

  const profile = await download();

  const files = Object.entries(profile.files).map(
    ([path, content]) => [safePath(path), content] as const,
  );

  const paths = files.map(([path]) => path);

  await installPackages(dir, packagesOf(profile), log, install);

  for (const [path, content] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await replace(join(dir, path), Buffer.from(content, "base64"));
  }

  const dropped = (copy?.files ?? earlierFiles).filter(
    (path) => !paths.includes(path),
  );

  for (const path of dropped) {
    await rm(join(dir, safePath(path)), { force: true });
  }

  await replace(
    join(dir, copyFile),
    JSON.stringify({ hash: profile.hash, files: paths }),
  );

  log("profile files written", { files: paths.length });
}

export type InstallPackage = (dir: string, source: string) => Promise<void>;

// Installs one package into a Profile's folder, with the git credentials of
// this process's environment.
export async function installPackage(
  dir: string,
  source: string,
): Promise<void> {
  const packageManager = new DefaultPackageManager({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.create(dir, dir),
  });

  await packageManager.install(source);
}

async function installPackages(
  dir: string,
  packages: readonly PiPackage[],
  log: Log,
  install: InstallPackage,
): Promise<void> {
  const installed = await installedSources(dir);

  const missing = packages
    .map(sourceOf)
    .filter((source) => !installed.has(source));

  if (missing.length === 0) {
    return;
  }

  for (const source of missing) {
    log("installing profile package", { source });

    await install(dir, source).catch((error: unknown) => {
      throw new Error(`package ${source} failed to install: ${String(error)}`, {
        cause: error,
      });
    });

    installed.add(source);
    await replace(join(dir, installedFile), JSON.stringify([...installed]));
  }

  log("profile packages installed", { count: missing.length });
}

function packagesOf(profile: ProfileFiles): readonly PiPackage[] {
  const settings = profile.files["settings.json"];
  if (settings === undefined) {
    return [];
  }

  try {
    const { packages } = JSON.parse(
      Buffer.from(settings, "base64").toString("utf8"),
    ) as { packages?: unknown };

    return Array.isArray(packages) ? (packages as PiPackage[]) : [];
  } catch {
    // Pi reports a settings.json it can't read when the Session starts.
    return [];
  }
}

async function copyOf(
  dir: string,
): Promise<{ hash: string; files: readonly string[] } | undefined> {
  try {
    const copy = JSON.parse(
      await readFile(join(dir, copyFile), "utf8"),
    ) as unknown;

    return typeof copy === "object" &&
      copy !== null &&
      "hash" in copy &&
      typeof copy.hash === "string" &&
      "files" in copy &&
      Array.isArray(copy.files) &&
      copy.files.every((path) => typeof path === "string")
      ? { hash: copy.hash, files: copy.files }
      : undefined;
  } catch {
    return undefined;
  }
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

// A path the server sent stays inside the folder.
function safePath(path: string): string {
  const normalized = normalize(path);
  if (
    normalized.startsWith("..") ||
    normalized.startsWith(sep) ||
    normalized.split(sep).includes("..")
  ) {
    throw new Error(`profile file ${path} is outside its folder`);
  }

  return normalized;
}

// The new file replaces the old one in one rename, so a reader never sees it
// half written.
async function replace(path: string, content: string | Buffer): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

function sourceOf(pkg: PiPackage): string {
  return typeof pkg === "string" ? pkg : pkg.source;
}
