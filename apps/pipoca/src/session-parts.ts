import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import askPackage from "@pipoca/ask/package.json";
import { ask } from "@pipoca/ask/session";
import changesPackage from "@pipoca/changes/package.json";
import { changes } from "@pipoca/changes/session";
import gitHostsPackage from "@pipoca/git-hosts/package.json";
import kubernetesPackage from "@pipoca/kubernetes/package.json";
import libraryPackage from "@pipoca/library/package.json";
import { library as librarySession } from "@pipoca/library/session";
import loginsPackage from "@pipoca/logins/package.json";
import { logins } from "@pipoca/logins/session";
import metaPackage from "@pipoca/meta/package.json";
import { metaSession } from "@pipoca/meta/session";
import modelsPackage from "@pipoca/models/package.json";
import { models as modelsSession } from "@pipoca/models/session";
import oidcPackage from "@pipoca/oidc/package.json";
import projectsPackage from "@pipoca/projects/package.json";
import subagentsPackage from "@pipoca/subagents/package.json";
import { subagents } from "@pipoca/subagents/session";
import usagePackage from "@pipoca/usage/package.json";
import { type SessionPlugin, settingValues } from "@pipoca/plugins";
import type {
  Assignment,
  PluginManifest,
  PluginSettings,
  SessionStart,
} from "@pipoca/protocol";
import { fetchSessionPart } from "./client";

// The plugins built into this binary (ADR 0015), described by the pipoca
// field of their package.json (ADR 0036). Each app imports its own parts
// statically, so the compiled binary needs no dynamic loading.
export const builtInPlugins: readonly PluginManifest[] = [
  askPackage,
  changesPackage,
  usagePackage,
  projectsPackage,
  libraryPackage,
  modelsPackage,
  subagentsPackage,
  kubernetesPackage,
  metaPackage,
  oidcPackage,
  gitHostsPackage,
  loginsPackage,
].map(({ pipoca }) => pipoca as PluginManifest);

export const sessionPlugins: readonly SessionPlugin[] = [
  ask,
  changes,
  librarySession,
  modelsSession,
  subagents,
  metaSession,
  logins,
];

// The Session parts an assignment names, each with its settings. A server
// from before settings sends none, so they take their defaults. An installed
// plugin's part comes from installed, by its bundle's hash.
export async function sessionParts(
  assignment: Pick<
    Assignment,
    "plugins" | "pluginSettings" | "requiredPlugins" | "installedParts"
  >,
  installed: (name: string, hash: string) => Promise<SessionPlugin>,
): Promise<{
  readonly plugins: readonly SessionPlugin[];
  readonly pluginSettings: Readonly<Record<string, PluginSettings>>;
}> {
  const parts = Object.entries(assignment.installedParts ?? {}).filter(
    ([name]) => assignment.plugins.includes(name),
  );

  const unknown = (assignment.requiredPlugins ?? []).filter(
    (name) =>
      !sessionPlugins.some((plugin) => plugin.name === name) &&
      !parts.some(([part]) => part === name),
  );

  if (unknown.length > 0) {
    throw new Error(
      `this runner has no ${unknown.join(", ")} plugin, so it needs an update`,
    );
  }

  const builtIn = sessionPlugins.filter(({ name }) =>
    assignment.plugins.includes(name),
  );

  const fetched = await Promise.all(
    parts.map(async ([name, hash]) => installed(name, hash)),
  );

  return {
    plugins: [...builtIn, ...fetched],
    pluginSettings: Object.fromEntries<PluginSettings>([
      ...builtIn.map(({ name }): [string, PluginSettings] => [
        name,
        settingValues(
          builtInPlugins.find(({ id }) => id === name)?.settings,
          assignment.pluginSettings?.[name],
        ),
      ]),
      ...fetched.map(({ name }): [string, PluginSettings] => [
        name,
        assignment.pluginSettings?.[name] ?? {},
      ]),
    ]),
  };
}

// Loads an installed plugin's Session part, fetching its bundle into the
// Session's folder the first time, so a reload doesn't fetch it again.
export function installedSessionParts(
  server: string,
  assignment: SessionStart,
  sessionDir: string,
): (name: string, hash: string) => Promise<SessionPlugin> {
  const dir = join(sessionDir, "plugin-parts");

  return async (name, hash) => {
    const path = join(dir, `${name}-${hash}.js`);

    if (!(await exists(path))) {
      const code = await fetchSessionPart(server, assignment, name, hash);
      const got = new Bun.CryptoHasher("sha256").update(code).digest("hex");

      if (got !== hash) {
        throw new Error(`the ${name} plugin's Session part changed on the way`);
      }

      // Two starts of one Session can fetch it at once.
      const partial = `${path}.${randomUUID()}`;

      await mkdir(dir, { recursive: true });
      await writeFile(partial, code);
      await rename(partial, path);
    }

    const { default: plugin } = (await import(path)) as {
      default?: SessionPlugin;
    };

    if (plugin?.name !== name) {
      throw new Error(
        `the ${name} plugin's Session part must export as default a Session part named ${name}`,
      );
    }

    return plugin;
  };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
