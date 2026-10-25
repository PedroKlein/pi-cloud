import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
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
import { bundleParts } from "./bundle";
import { builtInPlugins } from "./plugins";
import { fetchSource, type PluginSource } from "./sources";

// A plugin installed into the plugins folder, one folder each, named by its
// id (ADR 0022). Only the ones turned on are built and imported, since that
// runs the plugin's code.
export interface InstalledPlugin {
  readonly manifest: PluginManifest;
  readonly on: boolean;
  readonly server?: ServerPlugin;
  // The web part's bundle.
  readonly web?: string;
  // The Session part's bundle, and its SHA-256 that runners ask for it by.
  readonly session?: { readonly path: string; readonly hash: string };
  // Why its manifest or, when it is on, its code couldn't load.
  readonly error?: string;
  // Where it was installed from, unless it was put in the folder by hand.
  readonly source?: PluginSource;
}

const switchesFile = "enabled.json";
const sourceFile = ".source.json";
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

      if (!(await isFolder(folder))) {
        return [];
      }

      const source = await sourceOf(folder);

      return [
        {
          ...(await load(folder, name, on.includes(name))),
          ...(source && { source }),
        },
      ];
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

let changing = Promise.resolve();

// One install, update or removal at a time, so two can't take one id.
async function oneAtATime<T>(change: () => Promise<T>): Promise<T> {
  const next = changing.then(change);

  changing = next.then(
    () => undefined,
    () => undefined,
  );

  return next;
}

// Installed turned off, so none of its code runs until the user turns it on
// (ADR 0022).
export async function install(
  root: string,
  url: string,
  taken: (id: string) => boolean,
): Promise<InstalledPlugin> {
  return oneAtATime(async () => {
    await mkdir(root, { recursive: true });

    const staging = join(root, `.install-${randomUUID()}`);

    try {
      const source = { url, pinned: await fetchSource(url, staging) };
      const manifest = await stagedManifest(staging);

      if (taken(manifest.id) || (await isFolder(join(root, manifest.id)))) {
        throw new Error(`a plugin with the id ${manifest.id} is already here`);
      }

      await writeSource(staging, source);
      await rename(staging, join(root, manifest.id));

      return { manifest, on: false, source };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

// Fetches the newest version from where the plugin was installed from, to
// run when the server restarts. Undefined when it already has it.
export async function update(
  root: string,
  id: string,
): Promise<InstalledPlugin | undefined> {
  return oneAtATime(async () => {
    const folder = join(root, id);
    const installed = await sourceOf(folder);

    if (installed === undefined) {
      throw new Error(`${id} wasn't installed from a URL, so it can't update`);
    }

    const staging = join(root, `.install-${randomUUID()}`);

    try {
      const source = {
        url: installed.url,
        pinned: await fetchSource(installed.url, staging),
      };

      if (source.pinned === installed.pinned) {
        return undefined;
      }

      const manifest = await stagedManifest(staging);

      if (manifest.id !== id) {
        throw new Error(`its newest version has the id ${manifest.id}`);
      }

      await writeSource(staging, source);

      // The running version's bundles are served until the restart rebuilds
      // them, and its dependencies make the next install quicker.
      for (const kept of [".build", "node_modules"]) {
        await rm(join(staging, kept), { recursive: true, force: true });

        await rename(join(folder, kept), join(staging, kept)).catch(
          (error: unknown) => {
            if (!isMissing(error)) {
              throw error;
            }
          },
        );
      }

      const old = join(root, `.old-${randomUUID()}`);

      await rename(folder, old);
      await rename(staging, folder);
      await rm(old, { recursive: true, force: true });

      return { manifest, on: (await turnedOn(root)).includes(id), source };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

// A folder that links to a plugin elsewhere loses only the link.
export async function remove(root: string, id: string): Promise<void> {
  return oneAtATime(async () => {
    await rm(join(root, id), { recursive: true, force: true });
    await turnOn(root, id, false);
  });
}

async function stagedManifest(folder: string): Promise<PluginManifest> {
  const packageJson: unknown = JSON.parse(
    await readFile(join(folder, "package.json"), "utf8").catch(() => {
      throw new Error("it has no package.json at its top");
    }),
  );

  const { id } = fields(fields(packageJson)["piCloud"]);

  if (typeof id !== "string") {
    throw new Error("its package.json has no piCloud.id");
  }

  const error = skipReason(id, new Set(builtInPlugins.map((each) => each.id)));

  if (error !== undefined) {
    throw new Error(`piCloud.id ${id}: ${error}`);
  }

  return manifestOf(packageJson, id);
}

// A missing or broken record means it wasn't installed from a URL.
async function sourceOf(folder: string): Promise<PluginSource | undefined> {
  try {
    const { url, pinned } = fields(
      JSON.parse(await readFile(join(folder, sourceFile), "utf8")),
    );

    return typeof url === "string" && typeof pinned === "string"
      ? { url, pinned }
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeSource(
  folder: string,
  source: PluginSource,
): Promise<void> {
  await writeFile(
    join(folder, sourceFile),
    `${JSON.stringify(source, null, 2)}\n`,
  );
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

  const { server, web, session } = manifest.parts ?? {};

  if (
    !on ||
    (server === undefined && web === undefined && session === undefined)
  ) {
    return { manifest, on };
  }

  try {
    const bundles = await bundleParts(folder, {
      ...(server !== undefined && { server: await inside(folder, server) }),
      ...(web !== undefined && { web: await inside(folder, web) }),
      ...(session !== undefined && {
        session: await inside(folder, session),
      }),
    });

    const part =
      bundles.server === undefined
        ? undefined
        : ((await import(bundles.server)) as { default?: ServerPlugin })
            .default;

    if (server !== undefined && part?.name !== manifest.id) {
      throw new Error(
        `${server} must export as default a server part named ${manifest.id}`,
      );
    }

    return {
      manifest,
      on,
      ...(part && { server: part }),
      ...(bundles.web !== undefined && { web: bundles.web }),
      ...(bundles.session !== undefined && {
        session: {
          path: bundles.session,
          hash: new Bun.CryptoHasher("sha256")
            .update(await readFile(bundles.session))
            .digest("hex"),
        },
      }),
    };
  } catch (error) {
    return { manifest, on, error: messageOf(error) };
  }
}

// The real path of a part, which must stay inside the plugin's folder even
// through links.
async function inside(folder: string, part: string): Promise<string> {
  const entry = await realpath(resolve(folder, part));
  const path = relative(await realpath(folder), entry);

  if (isAbsolute(path) || path.split(sep)[0] === "..") {
    throw new Error(`${part} is outside the plugin's folder`);
  }

  return entry;
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

  const { server, web, session } = fields(parts);
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
    ...(field["ownSessionsOnly"] === true && { ownSessionsOnly: true }),
    parts: {
      ...(typeof server === "string" && { server }),
      ...(typeof web === "string" && { web }),
      ...(typeof session === "string" && { session }),
    },
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
