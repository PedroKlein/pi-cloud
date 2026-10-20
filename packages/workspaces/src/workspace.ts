import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Workspace } from "@pi-cloud/protocol";

const run = promisify(execFile);

export type Log = (
  message: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

export interface WorkspaceOptions {
  readonly dir: string;
  readonly folders: readonly string[];
}

export async function prepareWorkspace(
  workspace: Workspace,
  { dir, folders }: WorkspaceOptions,
  log: Log,
): Promise<string> {
  if (workspace.kind !== "clone") {
    const folder = absolute(workspace.path);
    if (!folders.some((allowed) => absolute(allowed) === folder)) {
      throw new Error(`folder not allowed: ${workspace.path}`);
    }

    if (workspace.kind === "folder") {
      return folder;
    }
  }

  if (await exists(dir)) {
    log("workspace reused", { dir });

    return dir;
  }

  if (workspace.kind === "worktree") {
    const { branch } = workspace;
    log("adding worktree", { folder: workspace.path, branch, dir });

    await mkdir(dirname(dir), { recursive: true });
    await git(absolute(workspace.path), "worktree", "add", "-b", branch, dir);
    log("worktree added", { dir });

    return dir;
  }

  const { repository, branch } = workspace;
  const partial = `${dir}.partial`;
  const started = Date.now();
  log("cloning workspace", { repository, branch, dir });

  await mkdir(dirname(dir), { recursive: true });
  await rm(partial, { recursive: true, force: true });
  try {
    await git(dirname(dir), "clone", "--", repository, partial);
    await git(partial, "switch", "--create", branch);
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }

  await rename(partial, dir);
  log("workspace cloned", { dir, ms: Date.now() - started });

  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  try {
    await run("git", args, {
      cwd,
      // Under systemd there is nobody to answer a credential prompt, so git
      // must fail instead of waiting for one.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim() ?? "";

    throw new Error(
      `git ${args[0] ?? ""} failed: ${stderr === "" ? String(error) : stderr}`,
      { cause: error },
    );
  }
}

function absolute(path: string): string {
  return resolve(
    path === "~" || path.startsWith("~/")
      ? join(homedir(), path.slice(1))
      : path,
  );
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
