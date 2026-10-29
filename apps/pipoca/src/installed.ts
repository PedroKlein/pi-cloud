import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ServerPlugin, settingSpecs } from "@pipoca/plugins";
import {
  capabilities,
  type PluginManifest,
  pluginEngine,
} from "@pipoca/protocol";
import type { Log } from "@pipoca/providers";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { bundleParts, type PluginParts, provideSdk } from "./bundle";
import { builtInPlugins } from "./session-parts";
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
  // A hash of its files, which the user reviews before turning it on.
  readonly digest?: string;
}

const switchesFile = "enabled.json";
const sourceFile = ".source.json";

// What the server makes or keeps in a plugin's folder itself.
const reserved = new Set([sourceFile, ".build", "node_modules", ".git"]);
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

  // What an install or update that didn't finish left behind.
  await Promise.all(
    folders
      .filter((name) => /^\.(install|old)-/.test(name))
      .map(async (name) =>
        rm(join(root, name), { recursive: true, force: true }),
      ),
  );

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
          digest: await digestOf(folder),
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

      // A switch left from a plugin of this id removed by hand.
      await turnOn(root, manifest.id, false);
      await writeSource(staging, source);
      await rename(staging, join(root, manifest.id));

      return {
        manifest,
        on: false,
        source,
        digest: await digestOf(join(root, manifest.id)),
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

// Fetches the newest version from where the plugin was installed from, to
// run when the server restarts. Undefined when it already has it. A version
// that asks for more than the one turned on is turned off first.
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

      const trusted = await stagedManifest(folder).catch(() => undefined);

      if (trusted === undefined || asksForMore(trusted, manifest)) {
        await turnOn(root, id, false);
      }

      await writeSource(staging, source);

      for (const kept of [".build", "node_modules"]) {
        await rm(join(staging, kept), { recursive: true, force: true });
      }

      const old = join(root, `.old-${randomUUID()}`);

      await rename(folder, old);

      try {
        await rename(staging, folder);
      } catch (error) {
        await rename(old, folder);
        throw error;
      }

      // The running version's bundles are served until the restart rebuilds
      // them, and its dependencies make the next install quicker.
      for (const kept of [".build", "node_modules"]) {
        await rename(join(old, kept), join(folder, kept)).catch(
          (error: unknown) => {
            if (!isMissing(error)) {
              throw error;
            }
          },
        );
      }

      await rm(old, { recursive: true, force: true });

      return {
        manifest,
        on: (await turnedOn(root)).includes(id),
        source,
        digest: await digestOf(folder),
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

// Turning a plugin on trusted what it asked for and where its parts ran then.
function asksForMore(trusted: PluginManifest, next: PluginManifest): boolean {
  const had = trusted.capabilities ?? [];

  return (
    (next.capabilities ?? []).some((each) => !had.includes(each)) ||
    (next.parts?.web !== undefined && trusted.parts?.web === undefined) ||
    (next.parts?.session !== undefined &&
      (trusted.parts?.session === undefined ||
        (trusted.ownSessionsOnly === true && next.ownSessionsOnly !== true)))
  );
}

// A folder that links to a plugin elsewhere loses only the link.
export async function remove(root: string, id: string): Promise<void> {
  return oneAtATime(async () => {
    await turnOn(root, id, false);
    await rm(join(root, id), { recursive: true, force: true });
  });
}

const identified = Type.Object({
  pipoca: Type.Object({ id: Type.String() }),
});

async function stagedManifest(folder: string): Promise<PluginManifest> {
  const packageJson: unknown = JSON.parse(
    await readFile(join(folder, "package.json"), "utf8").catch(() => {
      throw new Error("it has no package.json at its top");
    }),
  );

  if (!Value.Check(identified, packageJson)) {
    throw new Error("its package.json has no pipoca.id");
  }

  const { id } = packageJson.pipoca;
  const error = idProblem(id);

  if (error !== undefined) {
    throw new Error(`pipoca.id ${id}: ${error}`);
  }

  return manifestOf(packageJson, id);
}

const recordedSource = Type.Object({
  url: Type.String(),
  pinned: Type.String(),
});

// A missing or broken record means it wasn't installed from a URL.
export async function sourceOf(
  folder: string,
): Promise<PluginSource | undefined> {
  try {
    const source: unknown = JSON.parse(
      await readFile(join(folder, sourceFile), "utf8"),
    );

    return Value.Check(recordedSource, source)
      ? { url: source.url, pinned: source.pinned }
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
    const bundles = await builtParts(folder, manifest);

    provideSdk();

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

async function builtParts(
  folder: string,
  manifest: PluginManifest,
): Promise<PluginParts> {
  const { server, web, session } = manifest.parts ?? {};

  return bundleParts(folder, {
    ...(server !== undefined && { server: await inside(folder, server) }),
    ...(web !== undefined && { web: await inside(folder, web) }),
    ...(session !== undefined && { session: await inside(folder, session) }),
  });
}

// What a plugin's folder holds now, read again after it changed, without
// running any of its code.
export async function reread(
  root: string,
  id: string,
): Promise<InstalledPlugin> {
  const folder = join(root, id);
  const source = await sourceOf(folder);

  return {
    ...(await load(folder, id, false)),
    ...(source && { source }),
    digest: await digestOf(folder),
  };
}

// Every file but what the server keeps, so code changed after the user
// looked shows as a change, not only a changed manifest.
async function digestOf(folder: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");

  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);

  const files = entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    .filter((path) => !isReserved(path.split(sep)[0] ?? ""))
    .sort();

  for (const path of files) {
    const at = join(folder, path);

    const content = await readFile(at).catch(async () =>
      readlink(at).catch(() => ""),
    );

    hash.update(
      `${JSON.stringify(path)} ${new Bun.CryptoHasher("sha256").update(content).digest("hex")}\n`,
    );
  }

  return hash.digest("hex");
}

// Case-insensitive, as macOS's file system is.
export function isReserved(name: string): boolean {
  return reserved.has(name.normalize("NFC").toLowerCase());
}

// Builds a plugin that isn't running, so what is wrong shows before the user
// turns it on. Building runs none of its code.
export async function build(root: string, id: string): Promise<void> {
  const folder = join(root, id);

  const manifest = manifestOf(
    JSON.parse(await readFile(join(folder, "package.json"), "utf8")),
    id,
  );

  if (Object.keys(manifest.parts ?? {}).length === 0) {
    throw new Error(
      "it has no parts, so it would do nothing: list a server, web or session file in pipoca.parts",
    );
  }

  await builtParts(folder, manifest);
}

// Why a plugin can't have this id, if it can't.
export function idProblem(id: string): string | undefined {
  return skipReason(id, new Set(builtInPlugins.map((each) => each.id)));
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

// The pipoca field of a plugin's package.json (ADR 0022, ADR 0036).
const pluginPackage = Type.Object({
  pipoca: Type.Object({
    id: Type.String(),
    title: Type.String(),
    description: Type.String(),
    version: Type.Optional(Type.String()),
    engine: Type.Number(),
    capabilities: Type.Optional(Type.Array(Type.Enum(capabilities))),
    parts: Type.Optional(
      Type.Object({
        server: Type.Optional(Type.String()),
        web: Type.Optional(Type.String()),
        session: Type.Optional(Type.String()),
      }),
    ),
    ownSessionsOnly: Type.Optional(Type.Boolean()),
    settings: Type.Optional(Type.Unknown()),
  }),
});

function manifestOf(packageJson: unknown, folder: string): PluginManifest {
  if (!Value.Check(pluginPackage, packageJson)) {
    const [error] = Value.Errors(pluginPackage, packageJson);
    const field = error?.instancePath.slice(1).replaceAll("/", ".") ?? "";

    throw new Error(
      `${field === "" ? "package.json" : field} ${error?.message ?? "doesn't fit"}`,
    );
  }

  const { id, title, description, version, engine, parts, settings } =
    packageJson.pipoca;

  if (id !== folder) {
    throw new Error(`pipoca.id must be the folder's name, ${folder}`);
  }

  if (engine !== pluginEngine) {
    throw new Error(
      `pipoca.engine must be ${String(pluginEngine)}, the plugin interface this server has`,
    );
  }

  return {
    id,
    title,
    description,
    engine,
    capabilities: packageJson.pipoca.capabilities ?? [],
    ...(version !== undefined && { version }),
    ...(packageJson.pipoca.ownSessionsOnly === true && {
      ownSessionsOnly: true,
    }),
    parts: {
      ...(parts?.server !== undefined && { server: parts.server }),
      ...(parts?.web !== undefined && { web: parts.web }),
      ...(parts?.session !== undefined && { session: parts.session }),
    },
    ...(settings !== undefined && { settings: settingSpecs(settings) }),
  };
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
