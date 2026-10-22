import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const limit = 5000;

export interface WorkspaceFiles {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

// Paths `@` can mention (ADR 0006): what git tracks plus untracked files it
// doesn't ignore, or a walk outside git that skips hidden folders and
// node_modules.
export async function workspaceFiles(cwd: string): Promise<WorkspaceFiles> {
  const found = await gitFiles(cwd).catch(async () => walk(cwd));
  const paths = [...new Set(found)].sort();

  return { paths: paths.slice(0, limit), truncated: paths.length > limit };
}

async function gitFiles(cwd: string): Promise<readonly string[]> {
  const { stdout } = await promisify(execFile)(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd, maxBuffer: 64 * 1024 * 1024 },
  );

  return stdout.split("\0").filter((path) => path !== "");
}

async function walk(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const pending = [""];

  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    const entries = await readdir(join(root, dir), {
      withFileTypes: true,
    }).catch(() => []);

    for (const entry of entries) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;

      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          pending.push(path);
        }
      } else if (entry.isFile()) {
        paths.push(path);
      }

      if (paths.length > limit) {
        return paths;
      }
    }
  }

  return paths;
}
