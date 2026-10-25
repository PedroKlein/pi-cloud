import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ServerPlugin } from "@pi-cloud/plugins";
import {
  type Capability,
  capabilities,
  type PluginManifest,
  pluginEngine,
} from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";

// A plugin installed into the plugins folder, one folder each, named by its
// id (ADR 0022). Only the ones turned on are imported, since importing runs
// the plugin's code.
export interface InstalledPlugin {
  readonly manifest: PluginManifest;
  readonly on: boolean;
  readonly server?: ServerPlugin;
  // Why it couldn't load, when it is on.
  readonly error?: string;
}

const switchesFile = "enabled.json";
const idPattern = /^[a-z][a-z0-9-]*$/;

export async function installedPlugins(
  root: string,
  log: Log,
): Promise<InstalledPlugin[]> {
  const on = await turnedOn(root);

  const folders = await readdir(root, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (isMissing(error)) {
        return [];
      }

      throw error;
    },
  );

  const plugins = await Promise.all(
    folders
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async ({ name }) => load(join(root, name), name, on.includes(name))),
  );

  for (const plugin of plugins) {
    log("installed plugin found", {
      plugin: plugin.manifest.id,
      on: plugin.on,
      ...(plugin.error !== undefined && { error: plugin.error }),
    });
  }

  return plugins;
}

// Takes effect when the server next starts.
export async function turnOn(
  root: string,
  id: string,
  on: boolean,
): Promise<void> {
  const others = (await turnedOn(root)).filter((each) => each !== id);
  const next = on ? [...others, id].sort() : others;
  const temporary = join(root, `.${switchesFile}.${String(process.pid)}`);

  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temporary, join(root, switchesFile));
}

export async function turnedOn(root: string): Promise<string[]> {
  try {
    const ids: unknown = JSON.parse(
      await readFile(join(root, switchesFile), "utf8"),
    );

    return Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === "string")
      : [];
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }

    throw error;
  }
}

async function load(
  folder: string,
  name: string,
  on: boolean,
): Promise<InstalledPlugin> {
  const fallback: PluginManifest = { id: name, title: name, description: "" };

  let manifest: PluginManifest;
  try {
    manifest = manifestOf(
      JSON.parse(await readFile(join(folder, "package.json"), "utf8")),
      name,
    );
  } catch (error) {
    return { manifest: fallback, on, error: messageOf(error) };
  }

  if (!on || manifest.parts?.server === undefined) {
    return { manifest, on };
  }

  try {
    const entry = resolve(folder, manifest.parts.server);
    if (relative(folder, entry).startsWith("..")) {
      throw new Error(`parts.server is outside the plugin's folder`);
    }

    const { default: server } = (await import(entry)) as {
      default?: ServerPlugin;
    };

    if (server?.name !== manifest.id) {
      throw new Error(
        `${manifest.parts.server} must export as default a server part named ${manifest.id}`,
      );
    }

    return { manifest, on, server };
  } catch (error) {
    return { manifest, on, error: messageOf(error) };
  }
}

function manifestOf(packageJson: unknown, folder: string): PluginManifest {
  const field = fields(fields(packageJson)["piCloud"]);
  const { id, title, description, version, engine, parts } = field;

  if (id !== folder || !idPattern.test(folder)) {
    throw new Error(
      `piCloud.id must be the folder's name, ${folder}, in lowercase letters, digits and dashes`,
    );
  }

  if (typeof title !== "string" || typeof description !== "string") {
    throw new Error("piCloud needs a title and a description");
  }

  if (engine !== pluginEngine) {
    throw new Error(
      `piCloud.engine must be ${String(pluginEngine)}, the plugin interface this server has`,
    );
  }

  const server = fields(parts)["server"];
  const declared = field["capabilities"] ?? [];

  if (
    !Array.isArray(declared) ||
    !declared.every((each): each is Capability =>
      capabilities.includes(each as Capability),
    )
  ) {
    throw new Error(
      `piCloud.capabilities must list some of ${capabilities.join(", ")}`,
    );
  }

  const settings = field["settings"] as PluginManifest["settings"];

  return {
    id,
    title,
    description,
    engine,
    capabilities: declared,
    ...(typeof version === "string" && { version }),
    ...(typeof server === "string" && { parts: { server } }),
    ...(settings !== undefined && { settings }),
  };
}

function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
