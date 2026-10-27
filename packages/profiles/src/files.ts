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
