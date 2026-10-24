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

// Pi installs a plugin's packages on first use, as `pi -e npm:<name>` does. A
// package that can't be installed, say offline, is left out instead of failing
// the Session.
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
      const resolved = await packageManager.resolveExtensionSources([source], {
        temporary: true,
      });

      installed.push(source);

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
