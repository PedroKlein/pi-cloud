import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DefaultPackageManager,
  type Extension,
  type ExtensionError,
  type LoadExtensionsResult,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface PluginPackages {
  readonly sources: string[];
  readonly override: (result: LoadExtensionsResult) => LoadExtensionsResult;
}

// A plugin's packages are installed on first use. A package that can't be
// installed, say offline, is left out instead of failing the Session.
export async function pluginPackages(
  sources: readonly string[],
  pi: {
    readonly cwd: string;
    readonly agentDir: string;
    readonly settingsManager: SettingsManager;
  },
  onError: (error: ExtensionError) => void,
): Promise<PluginPackages> {
  const packageManager = new DefaultPackageManager(pi);
  const installed: string[] = [];
  const paths = new Set<string>();

  for (const source of sources) {
    try {
      const local = await localSource(source, pi.agentDir);
      if (local === undefined) {
        continue;
      }

      const resolved = await packageManager.resolveExtensionSources([local], {
        temporary: true,
      });

      installed.push(local);

      for (const { path } of resolved.extensions) {
        paths.add(path);
      }
    } catch (error) {
      onError({
        extensionPath: source,
        event: "install",
        error: String(error),
      });
    }
  }

  return { sources: installed, override: replaceable(paths) };
}

// Pi would install npm:<name>@<version> with npm, which a VM with only Bun
// lacks, so the running Bun installs it: a compiled binary acts as the bun CLI
// under BUN_BE_BUN. Offline, like Pi, it uses only what is already installed.
async function localSource(
  source: string,
  agentDir: string,
): Promise<string | undefined> {
  if (!source.startsWith("npm:")) {
    return source;
  }

  const spec = source.slice("npm:".length);
  const at = spec.indexOf("@", 1);
  const name = at > 0 ? spec.slice(0, at) : spec;

  const root = join(
    agentDir,
    "pi-cloud",
    "packages",
    spec.replaceAll("/", "+"),
  );

  const installed = join(root, "node_modules", name);

  if (existsSync(installed)) {
    return installed;
  }

  if (/^(1|true|yes)$/i.test(process.env["PI_OFFLINE"] ?? "")) {
    return undefined;
  }

  // Sessions starting together each install into their own directory, and
  // the first to finish keeps its install.
  const staging = `${root}.${String(process.pid)}`;
  await mkdir(staging, { recursive: true });

  try {
    await writeFile(
      join(staging, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: { [name]: at > 0 ? spec.slice(at + 1) : "latest" },
      }),
    );

    await promisify(execFile)(process.execPath, ["install", "--production"], {
      cwd: staging,
      env: { ...process.env, BUN_BE_BUN: "1" },
    });

    await rename(staging, root).catch(() => undefined);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  return installed;
}

// Like Pi's replaceable built-ins: an extension of the user's own that
// registers a tool, command or flag of a plugin's package replaces it, so a
// user who installed the same package keeps their version and settings.
function replaceable(
  paths: ReadonlySet<string>,
): (result: LoadExtensionsResult) => LoadExtensionsResult {
  return (result) => {
    const taken = new Set(
      result.extensions
        .filter(({ path }) => !paths.has(path))
        .flatMap(registeredNames),
    );

    const replaced = result.extensions
      .filter(({ path }) => paths.has(path))
      .filter((extension) =>
        registeredNames(extension).some((name) => taken.has(name)),
      )
      .map(({ path }) => path);

    // Pi reports two extensions with one tool name as an error before the
    // override runs.
    const clashes = ({ path, error }: { path: string; error: string }) =>
      replaced.some((each) => path === each || error.endsWith(` ${each}`));

    return {
      ...result,
      extensions: result.extensions.filter(
        ({ path }) => !replaced.includes(path),
      ),
      errors: result.errors.filter((error) => !clashes(error)),
    };
  };
}

function registeredNames(extension: Extension): string[] {
  return [
    ...[...extension.tools.keys()].map((name) => `tool:${name}`),
    ...[...extension.commands.keys()].map((name) => `command:${name}`),
    ...[...extension.flags.keys()].map((name) => `flag:${name}`),
  ];
}
