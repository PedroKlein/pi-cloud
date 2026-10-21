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

export interface PreparedWorkspace {
  readonly cwd: string;
  readonly base: string | null;
}

export interface WorkspaceOptions {
  readonly dir: string;
  readonly folders: readonly string[];
}

export async function prepareWorkspace(
  workspace: Workspace,
  { dir, folders }: WorkspaceOptions,
  log: Log,
): Promise<PreparedWorkspace> {
  if (workspace.kind !== "clone") {
    const folder = absolute(workspace.path);
    if (!folders.some((allowed) => absolute(allowed) === folder)) {
      throw new Error(`folder not allowed: ${workspace.path}`);
    }

    if (workspace.kind === "folder") {
      return { cwd: folder, base: null };
    }
  }

  const { branch } = workspace;
  if (await exists(dir)) {
    log("workspace reused", { dir });

    return { cwd: dir, base: await readBase(dir, branch) };
  }

  if (workspace.kind === "worktree") {
    log("adding worktree", { folder: workspace.path, branch, dir });

    await mkdir(dirname(dir), { recursive: true });
    await git(absolute(workspace.path), "worktree", "add", "-b", branch, dir);
    log("worktree added", { dir });

    return { cwd: dir, base: await recordBase(dir, branch) };
  }

  const { repository } = workspace;
  const partial = `${dir}.partial`;
  let base: string | null;
  const started = Date.now();
  log("cloning workspace", { repository, branch, dir });

  await mkdir(dirname(dir), { recursive: true });
  await rm(partial, { recursive: true, force: true });
  try {
    await git(dirname(dir), "clone", "--", repository, partial);
    await git(partial, "switch", "--create", branch);
    base = await recordBase(partial, branch);
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }

  await rename(partial, dir);
  log("workspace cloned", { dir, ms: Date.now() - started });

  return { cwd: dir, base };
}

// The commit a session branch started from, kept in the branch's git config
// so a later attempt, and git itself when the branch is deleted, know it.
const baseKey = (branch: string): string => `branch.${branch}.piCloudBase`;

async function recordBase(dir: string, branch: string): Promise<string | null> {
  const head = await git(dir, "rev-parse", "--verify", "--quiet", "HEAD").catch(
    () => null,
  );

  if (head !== null) {
    await git(dir, "config", baseKey(branch), head);
  }

  return head;
}

async function readBase(dir: string, branch: string): Promise<string | null> {
  return git(dir, "config", "--get", baseKey(branch)).catch(() => null);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      // Under systemd there is nobody to answer a credential prompt, so git
      // must fail instead of waiting for one.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    return stdout.trim();
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
