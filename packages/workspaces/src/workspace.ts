import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { Workspace } from "@pi-cloud/protocol";

const run = promisify(execFile);

export type Log = (
  message: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

export async function prepareWorkspace(
  workspace: Workspace,
  dir: string,
  log: Log,
): Promise<string> {
  if (workspace.kind === "folder") {
    return workspace.path;
  }

  if (await exists(dir)) {
    log("workspace reused", { dir });

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

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
