import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { idProblem, sourceOf } from "./installed";

// The files of a plugin a meta-session writes straight into the plugins
// folder (ADR 0035). None of its code runs until the user turns it on.

const maxFileBytes = 1024 * 1024;

// What the server makes or keeps in a plugin's folder itself.
const reserved = new Set([".source.json", ".build", "node_modules", ".git"]);

export async function pluginFiles(root: string, id: string): Promise<string[]> {
  const folder = await pluginFolder(root, id);

  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    .filter((path) => !reserved.has(path.split(sep)[0] ?? ""))
    .sort();
}

export async function readPluginFile(
  root: string,
  id: string,
  path: string,
): Promise<string> {
  const target = await insideFolder(await pluginFolder(root, id), path);

  if ((await lstat(target)).size > maxFileBytes) {
    throw new Error(`${path} is bigger than 1 MB`);
  }

  return readFile(target, "utf8");
}

// Makes the plugin's folder when it has none yet. A plugin installed from a
// URL changes only by updating, so its files stay what was pinned.
export async function writePluginFile(
  root: string,
  id: string,
  path: string,
  content: string,
): Promise<void> {
  const problem = idProblem(id);

  if (problem !== undefined) {
    throw new Error(problem);
  }

  if (Buffer.byteLength(content) > maxFileBytes) {
    throw new Error("a plugin's file can be at most 1 MB");
  }

  const folder = join(root, id);

  await mkdir(folder, { recursive: true });
  await pluginFolder(root, id);

  if ((await sourceOf(folder)) !== undefined) {
    throw new Error(
      `${id} was installed from a URL, so it changes only by updating`,
    );
  }

  const target = await insideFolder(folder, path);

  // Folders are made only inside the plugin's folder, even through links.
  await contained(folder, await nearestFolder(dirname(target)), path);
  await mkdir(dirname(target), { recursive: true });

  // Through the parent's real path, so a link among the folders can't lead
  // the write outside the plugin.
  const parent = await contained(folder, dirname(target), path);
  const temporary = join(parent, `.${basename(target)}.${randomUUID()}`);

  await writeFile(temporary, content);

  // Renaming replaces a link at the target instead of writing through it.
  await rename(temporary, join(parent, basename(target))).catch(
    async (error: unknown) => {
      await rm(temporary, { force: true });
      throw error;
    },
  );
}

// A folder linked from elsewhere belongs to whoever develops it there.
async function pluginFolder(root: string, id: string): Promise<string> {
  const folder = join(root, id);
  const found = await lstat(folder).catch(() => undefined);

  if (found === undefined) {
    throw new Error(`no installed plugin ${id}`);
  }

  if (!found.isDirectory()) {
    throw new Error(`${id} links to a folder elsewhere; change it there`);
  }

  return folder;
}

// The real path of a file in the plugin's folder, refusing one outside it
// or among what the server keeps there.
async function insideFolder(folder: string, path: string): Promise<string> {
  if (path === "" || isAbsolute(path)) {
    throw new Error("a file's path is relative to the plugin's folder");
  }

  const lexical = relative(folder, join(folder, path));
  const [first = ""] = lexical.split(sep);

  if (lexical === "" || first === ".." || reserved.has(first)) {
    throw new Error(`${path} isn't a file the plugin can have`);
  }

  const real = await realpath(join(folder, lexical)).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return undefined;
    }

    throw error;
  });

  return real === undefined
    ? join(folder, lexical)
    : contained(folder, real, path);
}

async function nearestFolder(path: string): Promise<string> {
  for (let at = path; ; at = dirname(at)) {
    if ((await lstat(at).catch(() => undefined)) !== undefined) {
      return at;
    }
  }
}

async function contained(
  folder: string,
  real: string,
  path: string,
): Promise<string> {
  const resolved = await realpath(real);
  const within = relative(await realpath(folder), resolved);

  if (isAbsolute(within) || within.split(sep)[0] === "..") {
    throw new Error(`${path} leads outside the plugin's folder`);
  }

  return resolved;
}
