import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Changes } from "./report";

const run = promisify(execFile);

const patchLimit = 256 * 1024;

const outputLimit = 64 * 1024 * 1024;

// The cap the files live event uses (ADR 0006), so a large change set doesn't
// put megabytes on the live queue after every turn.
const fileLimit = 5000;

const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Diffs a throwaway copy of the index with every file added, so new files
// show up in the patch without touching the user's own index.
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

    await git(cwd, { env }, "add", "--all");

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

    const diff = ["diff", "--cached", "--no-color", "--no-ext-diff", against];
    const names = await git(cwd, { env }, ...diff, "--name-status", "-z");

    const stat = await git(
      cwd,
      { env },
      ...diff,
      `--stat-count=${String(fileLimit)}`,
    );

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

    const files = parseNameStatus(names);

    return {
      files: files.slice(0, fileLimit),
      fileCount: files.length,
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
