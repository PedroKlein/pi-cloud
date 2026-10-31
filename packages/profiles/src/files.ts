import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ProfileContent,
  type ProfileFiles,
  profilePath,
} from "@pipoca/protocol";

// Every runner that starts a Session with a Profile downloads its files, so
// a folder this big is refused (ADR 0041).
export const maxProfileBytes = 20 * 1024 * 1024;

export class ProfileTooBig extends Error {}

// A Profile folder's files as runners get them.
export function folderFiles(dir: string, name: string): ProfileFiles {
  const files = new Map<string, Buffer>();
  let bytes = 0;

  for (const { path, size } of folderEntries(dir)) {
    bytes += size;
    if (bytes > maxProfileBytes) {
      throw tooBig(name);
    }

    files.set(path, readFileSync(join(dir, path)));
  }

  return encoded(files);
}

// The paths and sizes of a Profile folder's files, leaving out what machines
// keep. Only regular files count, so a link can't hand runners a file from
// elsewhere on the server.
export function folderEntries(
  dir: string,
): readonly { readonly path: string; readonly size: number }[] {
  const found: { path: string; size: number }[] = [];

  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative))) {
      const path = relative === "" ? entry : `${relative}/${entry}`;
      if (!profilePath(path)) {
        continue;
      }

      const stats = lstatSync(join(dir, path));
      if (stats.isDirectory()) {
        walk(path);
      } else if (stats.isFile()) {
        found.push({ path, size: stats.size });
      }
    }
  };

  walk("");

  return found.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function tooBig(name: string): ProfileTooBig {
  return new ProfileTooBig(
    `Profile ${name} is over ${String(maxProfileBytes / 1024 / 1024)} MB`,
  );
}

// The files a Profile given as content stands for, such as a plugin's.
export function contentFiles(content: ProfileContent): ProfileFiles {
  const settings = {
    ...content.settings,
    ...(content.packages.length > 0 && { packages: content.packages }),
  };

  const texts: [string, string][] = [
    [
      "settings.json",
      Object.keys(settings).length === 0 ? "" : JSON.stringify(settings),
    ],
    ["AGENTS.md", content.agentsMd],
    ["SYSTEM.md", content.systemMd],
    ["APPEND_SYSTEM.md", content.appendSystemMd],
    [
      "mcp.json",
      Object.keys(content.mcpServers).length === 0
        ? ""
        : JSON.stringify({ mcpServers: content.mcpServers }),
    ],
  ];

  return encoded(
    new Map(
      texts
        .filter(([, text]) => text !== "")
        .map(([path, text]) => [path, Buffer.from(text)]),
    ),
  );
}

// A plugin's Profile over only the extensions and packages of the admin's
// base Profile, which add model providers. The base's skills, context, MCP
// servers and other settings stay out.
export function overBaseExtensions(
  base: ProfileFiles,
  own: ProfileFiles,
): ProfileFiles {
  const kept = new Map(
    [...decoded(base)].filter(([path]) => path.startsWith("extensions/")),
  );

  const packages = jsonOf(base, "settings.json")?.["packages"];
  if (Array.isArray(packages) && packages.length > 0) {
    kept.set("settings.json", Buffer.from(JSON.stringify({ packages })));
  }

  return layered(encoded(kept), own);
}

// A Profile's files over the admin's base Profile, layered as Pi layers its
// global and project config (ADR 0044).
export function layered(base: ProfileFiles, own: ProfileFiles): ProfileFiles {
  const files = new Map([...decoded(base), ...decoded(own)]);

  const json = (
    path: string,
    merge: (a: Settings, b: Settings) => Settings,
  ) => {
    const under = jsonOf(base, path);
    const over = jsonOf(own, path);
    if (under !== undefined && over !== undefined) {
      files.set(path, Buffer.from(JSON.stringify(merge(under, over))));
    }
  };

  json("settings.json", (under, over) => {
    const packages = packagesOver(under["packages"], over["packages"]);
    const { packages: _, ...merged } = deepMerge(under, over);

    return { ...merged, ...(packages.length > 0 && { packages }) };
  });

  json("mcp.json", deepMerge);

  const agents = [base, own].flatMap((layer) => {
    const text = layer.files["AGENTS.md"];

    return text === undefined ? [] : [Buffer.from(text, "base64").toString()];
  });

  if (agents.length > 0) {
    files.set("AGENTS.md", Buffer.from(agents.join("\n\n")));
  }

  return encoded(files);
}

type Settings = Record<string, unknown>;

function decoded(files: ProfileFiles): Map<string, Buffer> {
  return new Map(
    Object.entries(files.files).map(([path, content]) => [
      path,
      Buffer.from(content, "base64"),
    ]),
  );
}

// Pi reports a file it can't read when the Session starts, so one that isn't
// a JSON object is taken as it is.
function jsonOf(files: ProfileFiles, path: string): Settings | undefined {
  const content = files.files[path];
  if (content === undefined) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(
      Buffer.from(content, "base64").toString(),
    );

    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// Pi's own merge of its global and project settings.
function deepMerge(under: Settings, over: Settings): Settings {
  const merged = { ...under };

  for (const [key, value] of Object.entries(over)) {
    const below = under[key];

    merged[key] =
      isObject(below) && isObject(value) ? deepMerge(below, value) : value;
  }

  return merged;
}

// Packages from both load, and a Profile's entry for a source replaces the
// base's.
function packagesOver(under: unknown, over: unknown): unknown[] {
  const listed = (value: unknown): unknown[] =>
    Array.isArray(value) ? (value as unknown[]) : [];

  const sourceOf = (pkg: unknown): unknown =>
    isObject(pkg) ? pkg["source"] : pkg;

  const own = new Set(listed(over).map(sourceOf));

  return [
    ...listed(under).filter((pkg) => !own.has(sourceOf(pkg))),
    ...listed(over),
  ];
}

function isObject(value: unknown): value is Settings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encoded(files: ReadonlyMap<string, Buffer>): ProfileFiles {
  const paths = [...files.keys()].sort((a, b) => (a < b ? -1 : 1));
  const hash = createHash("sha256");

  for (const path of paths) {
    const content = files.get(path) ?? Buffer.alloc(0);
    hash.update(`${path}\0${String(content.length)}\0`);
    hash.update(content);
  }

  return {
    hash: hash.digest("hex"),
    files: Object.fromEntries(
      paths.map((path) => [
        path,
        (files.get(path) ?? Buffer.alloc(0)).toString("base64"),
      ]),
    ),
  };
}
