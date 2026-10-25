import { randomUUID } from "node:crypto";
import {
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ServerPlugin } from "@pi-cloud/plugins";
import {
  type Capability,
  capabilities,
  type PluginManifest,
  pluginEngine,
} from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";
import { bundleServerPart } from "./bundle";
import { builtInPlugins } from "./plugins";

// A plugin installed into the plugins folder, one folder each, named by its
// id (ADR 0022). Only the ones turned on are built and imported, since that
// runs the plugin's code.
export interface InstalledPlugin {
  readonly manifest: PluginManifest;
  readonly on: boolean;
  readonly server?: ServerPlugin;
  // Why its manifest or, when it is on, its code couldn't load.
  readonly error?: string;
}

const switchesFile = "enabled.json";
const idPattern = /^[a-z][a-z0-9-]*$/;

export async function installedPlugins(
  root: string,
  log: Log,
): Promise<InstalledPlugin[]> {
  const builtIn = new Set(builtInPlugins.map(({ id }) => id));
  const on = await turnedOn(root);

  const folders = await readdir(root).catch((error: unknown) => {
    if (isMissing(error)) {
      return [];
    }

    throw error;
  });

  const named = folders.filter((name) => {
    if (name.startsWith(".")) {
      return false;
    }

    const error = skipReason(name, builtIn);

    if (error !== undefined) {
      log("installed plugin skipped", { folder: name, error });
    }

    return error === undefined;
  });

  const plugins = await Promise.all(
    named.map(async (name) => {
      const folder = join(root, name);

      return (await isFolder(folder))
        ? [await load(folder, name, on.includes(name))]
        : [];
    }),
  );

  for (const plugin of plugins.flat()) {
    log("installed plugin found", {
      plugin: plugin.manifest.id,
      on: plugin.on,
      ...(plugin.error !== undefined && { error: plugin.error }),
    });
  }

  return plugins.flat();
}

let switching = Promise.resolve();

// Takes effect when the server next starts. Writes go one at a time, so two
// switches at once both land.
export async function turnOn(
  root: string,
  id: string,
  on: boolean,
): Promise<void> {
  const write = switching.then(async () => {
    const others = (await turnedOn(root)).filter((each) => each !== id);
    const next = on ? [...others, id].sort() : others;
    const temporary = join(root, `.${switchesFile}.${randomUUID()}`);

    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
    await rename(temporary, join(root, switchesFile));
  });

  switching = write.catch(() => undefined);

  return write;
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
    // A file broken by hand turns every installed plugin off rather than
    // keeping the server from starting.
    if (isMissing(error) || error instanceof SyntaxError) {
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
    const entry = await realpath(resolve(folder, manifest.parts.server));
    const path = relative(await realpath(folder), entry);

    if (isAbsolute(path) || path.split(sep)[0] === "..") {
      throw new Error(`parts.server is outside the plugin's folder`);
    }

    const { default: server } = (await import(
      await bundleServerPart(folder, entry)
    )) as {
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

  if (id !== folder) {
    throw new Error(`piCloud.id must be the folder's name, ${folder}`);
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

function skipReason(
  name: string,
  builtIn: ReadonlySet<string>,
): string | undefined {
  if (!idPattern.test(name)) {
    return "a plugin's folder is its id, in lowercase letters, digits and dashes";
  }

  if (builtIn.has(name)) {
    return "a built-in plugin has this id";
  }

  return undefined;
}

// A folder or a link to one, as when a plugin is developed elsewhere.
async function isFolder(path: string): Promise<boolean> {
  return stat(path).then(
    (found) => found.isDirectory(),
    () => false,
  );
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
