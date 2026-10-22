import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Changes } from "./report";

const run = promisify(execFile);

const patchLimit = 256 * 1024;

const outputLimit = 64 * 1024 * 1024;

const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Diffs the working tree through a throwaway copy of the index with every new
// file marked intent-to-add, so new files show up in the patch without
// touching the user's own index or writing their contents to the object
// store. Submodules show only a moved commit, as in a staged diff.
export async function workspaceChanges(
  cwd: string,
  base: string | null,
): Promise<Changes | undefined> {
  const index = await git(cwd, {}, "rev-parse", "--git-path", "index").catch(
    () => undefined,
  );

  if (index === undefined) {
    return undefined;
  }

  const scratch = await mkdtemp(join(tmpdir(), "pi-cloud-changes-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") };

  try {
    await copyFile(resolve(cwd, index), env.GIT_INDEX_FILE).catch(
      () => undefined,
    );

    await git(cwd, { env }, "add", "--all", "--intent-to-add");

    const against =
      base ??
      (await git(
        cwd,
        { env },
        "rev-parse",
        "--verify",
        "--quiet",
        "HEAD",
      ).catch(() => emptyTree));

    const diff = [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--ignore-submodules=dirty",
      against,
    ];

    const names = await git(cwd, { env }, ...diff, "--name-status", "-z");
    const stat = await git(cwd, { env }, ...diff, "--stat");

    const patch = await git(
      cwd,
      { env, maxBuffer: patchLimit },
      ...diff,
      "--binary",
    ).catch((error: unknown) => {
      if (
        (error as { code?: unknown }).code ===
        "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ) {
        return undefined;
      }

      throw error;
    });

    return {
      files: parseNameStatus(names),
      stat,
      patch: patch ?? "",
      truncated: patch === undefined,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function parseNameStatus(output: string): Changes["files"] {
  const fields = output.split("\0").filter((field) => field !== "");
  const files: { status: string; path: string }[] = [];

  for (let i = 0; i < fields.length;) {
    const status = fields[i] ?? "";
    const renamed = status.startsWith("R") || status.startsWith("C");
    const path = fields[i + (renamed ? 2 : 1)] ?? "";
    files.push({ status: status.slice(0, 1), path });
    i += renamed ? 3 : 2;
  }

  return files;
}

async function git(
  cwd: string,
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly maxBuffer?: number;
  },
  ...args: string[]
): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    env: { ...process.env, ...options.env },
    maxBuffer: options.maxBuffer ?? outputLimit,
  });

  return stdout.trimEnd();
}
