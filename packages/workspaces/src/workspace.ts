import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  checkoutName,
  type RemovalReport,
  type Workspace,
} from "@pi-cloud/protocol";

const run = promisify(execFile);

export type Log = (
  message: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

// A git checkout in a workspace and the commit its session branch started
// from, if it has one.
export interface Checkout {
  readonly path: string;
  readonly base: string | null;
}

export interface PreparedWorkspace {
  readonly cwd: string;
  readonly checkouts: readonly Checkout[];
}

type SingleWorkspace = Exclude<Workspace, { kind: "repositories" }>;

export interface WorkspaceOptions {
  readonly dir: string;
  readonly folders: readonly string[];
  readonly mirrors?: string;
}

export async function prepareWorkspace(
  workspace: Workspace,
  options: WorkspaceOptions,
  log: Log,
): Promise<PreparedWorkspace> {
  if (workspace.kind !== "repositories") {
    const { cwd, base } = await prepareCheckout(workspace, options, log);

    return { cwd, checkouts: [{ path: cwd, base }] };
  }

  const { dir, folders } = options;
  const { branch } = workspace;
  await mkdir(dir, { recursive: true });

  // Each repository becomes a worktree of a listed folder that has it as a
  // remote, or a clone when none does.
  const checkouts = await Promise.all(
    workspace.repositories.map(async ({ repository, startPoint }) => {
      const folder = await folderOf(repository, folders);
      const start = startPoint === undefined ? {} : { startPoint };

      const { cwd, base } = await prepareCheckout(
        folder === undefined
          ? { kind: "clone", repository, branch, ...start }
          : { kind: "worktree", path: folder, branch, ...start },
        { ...options, dir: join(dir, checkoutName(repository)) },
        log,
      );

      return { path: cwd, base };
    }),
  );

  return { cwd: dir, checkouts };
}

async function prepareCheckout(
  workspace: SingleWorkspace,
  { dir, folders, mirrors }: WorkspaceOptions,
  log: Log,
): Promise<{ readonly cwd: string; readonly base: string | null }> {
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
    const inCheckout = await git(
      absolute(workspace.path),
      "rev-parse",
      "--is-inside-work-tree",
    ).catch(() => "false");

    if (inCheckout !== "true") {
      throw new Error(
        `${workspace.path} is not a git checkout, so it can't have a worktree: start a folder session to run Pi in it directly`,
      );
    }

    log("adding worktree", { folder: workspace.path, branch, dir });

    await mkdir(dirname(dir), { recursive: true });

    await git(
      absolute(workspace.path),
      "worktree",
      "add",
      "-b",
      branch,
      dir,
      ...(workspace.startPoint === undefined ? [] : [workspace.startPoint]),
    );

    const copied = await copyIncluded(workspace.path, dir);
    log("worktree added", { dir, copied });

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
    await cloneWithMirror(repository, partial, mirrors, log);

    await git(
      partial,
      "switch",
      "--no-track",
      "--create",
      branch,
      ...(workspace.startPoint === undefined
        ? []
        : [await remoteStartPoint(partial, workspace.startPoint)]),
    );

    base = await recordBase(partial, branch);
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }

  await rename(partial, dir);
  log("workspace cloned", { dir, ms: Date.now() - started });

  return { cwd: dir, base };
}

// Removes a session's workspace only when git says nothing would be lost in
// any of its checkouts, unless forced. A removed workspace can be prepared
// again from restore.
export async function removeWorkspace(
  workspace: Workspace,
  options: { readonly dir: string; readonly force: boolean },
  log: Log,
): Promise<RemovalReport> {
  if (workspace.kind !== "repositories") {
    return removeCheckout(workspace, options, log);
  }

  const { dir, force } = options;
  const { branch } = workspace;

  const checkouts = await Promise.all(
    workspace.repositories.map(async (checkout) => {
      const path = join(dir, checkoutName(checkout.repository));
      const folder = await worktreeFolder(path);

      return {
        checkout,
        path,
        workspace:
          folder === undefined
            ? ({
                kind: "clone",
                repository: checkout.repository,
                branch,
              } as const)
            : ({ kind: "worktree", path: folder, branch } as const),
      };
    }),
  );

  if (!force) {
    const names = new Set(
      workspace.repositories.map(({ repository }) => checkoutName(repository)),
    );

    const outside = (await exists(dir))
      ? (await readdir(dir)).filter((name) => !names.has(name)).sort()
      : [];

    if (outside.length > 0) {
      const reason = `files outside the repositories: ${outside.join(", ")}`;
      log("workspace kept", { dir, reason });

      return { outcome: "kept", reason };
    }

    for (const { checkout, path, workspace: single } of checkouts) {
      const present = await exists(path);
      const reason = await lossOf(single, path, present, present);
      if (reason !== null) {
        log("workspace kept", { dir, reason, repository: checkout.repository });

        return {
          outcome: "kept",
          reason: `${checkoutName(checkout.repository)}: ${reason}`,
        };
      }
    }
  }

  const repositories = [];
  for (const { checkout, path, workspace: single } of checkouts) {
    const report = await removeCheckout(
      single,
      { dir: path, force: true },
      log,
    );

    const restored =
      report.outcome === "removed" &&
      (report.restore.kind === "worktree" || report.restore.kind === "clone")
        ? report.restore.startPoint
        : undefined;

    repositories.push({
      ...checkout,
      ...(restored !== undefined && { startPoint: restored }),
    });
  }

  await rm(dir, { recursive: true, force: true });

  return { outcome: "removed", restore: { ...workspace, repositories } };
}

async function removeCheckout(
  workspace: SingleWorkspace,
  { dir, force }: { readonly dir: string; readonly force: boolean },
  log: Log,
): Promise<RemovalReport> {
  if (workspace.kind === "folder") {
    return { outcome: "kept", reason: "folder workspaces are never removed" };
  }

  const repository =
    workspace.kind === "worktree" ? absolute(workspace.path) : dir;

  const present = await exists(dir);

  const orphaned = workspace.kind === "worktree" && !(await exists(repository));

  const hasBranch =
    !orphaned &&
    (present || workspace.kind === "worktree") &&
    (await git(
      repository,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${workspace.branch}`,
    ).then(
      () => true,
      () => false,
    ));

  if (!force) {
    const reason = await lossOf(workspace, dir, present, hasBranch);
    if (reason !== null) {
      log("workspace kept", { dir, reason });

      return { outcome: "kept", reason };
    }
  }

  if (orphaned) {
    await rm(dir, { recursive: true, force: true });
    log("workspace removed", { dir, force, restore: null });

    return { outcome: "removed", restore: workspace };
  }

  const restore = hasBranch
    ? await remoteHolding(repository, workspace.branch)
    : null;

  if (workspace.kind === "clone") {
    await rm(dir, { recursive: true, force: true });
  } else {
    await (present
      ? git(repository, "worktree", "remove", "--force", "--force", dir)
      : git(repository, "worktree", "prune"));

    if (hasBranch) {
      await git(repository, "branch", "--delete", "--force", workspace.branch);
    }
  }

  log("workspace removed", { dir, force, restore });

  return {
    outcome: "removed",
    restore:
      restore === null ? workspace : { ...workspace, startPoint: restore },
  };
}

async function lossOf(
  workspace: Exclude<SingleWorkspace, { kind: "folder" }>,
  dir: string,
  present: boolean,
  hasBranch: boolean,
): Promise<string | null> {
  // Without the checkout it came from, git can't tell what a worktree holds.
  if (
    workspace.kind === "worktree" &&
    !(await exists(absolute(workspace.path)))
  ) {
    return present ? "the folder it was checked out from is gone" : null;
  }

  if (present && (await git(dir, "status", "--porcelain")) !== "") {
    return "uncommitted changes";
  }

  if (!hasBranch) {
    return null;
  }

  const unpushed =
    workspace.kind === "clone"
      ? await git(dir, "rev-list", "--branches", "--not", "--remotes")
      : await git(
          absolute(workspace.path),
          "rev-list",
          workspace.branch,
          "--not",
          "--remotes",
        );

  return unpushed === "" ? null : "unpushed commits";
}

// The listed folder whose remotes include repository, if any.
async function folderOf(
  repository: string,
  folders: readonly string[],
): Promise<string | undefined> {
  const wanted = repositoryKey(repository);

  for (const folder of folders) {
    const urls = await git(
      absolute(folder),
      "config",
      "--get-regexp",
      "^remote\\..*\\.url$",
    ).catch(() => "");

    const matches = urls
      .split("\n")
      .map((line) => line.slice(line.indexOf(" ") + 1))
      .some((url) => url !== "" && repositoryKey(url) === wanted);

    if (matches) {
      return absolute(folder);
    }
  }

  return undefined;
}

// One spelling for the URLs git accepts for a repository, so that
// git@host:org/repo.git and https://host/org/repo match.
function repositoryKey(url: string): string {
  if (url.startsWith("/") || url.startsWith("~")) {
    return absolute(url)
      .replace(/\/+$/, "")
      .replace(/\.git$/, "");
  }

  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

// The checkout a worktree at path belongs to, or undefined when path is
// missing or a checkout of its own.
// Reads the worktree's .git file rather than asking git, which fails once
// the checkout is gone: it holds "gitdir: <checkout>/.git/worktrees/<name>".
async function worktreeFolder(path: string): Promise<string | undefined> {
  const link = await readFile(join(path, ".git"), "utf8").catch(() => "");
  const gitdir = /^gitdir: (.+)$/m.exec(link)?.[1];

  return gitdir === undefined
    ? undefined
    : dirname(dirname(dirname(resolve(path, gitdir.trim()))));
}

async function remoteHolding(
  repository: string,
  branch: string,
): Promise<string | null> {
  const refs = paths(
    await git(
      repository,
      "for-each-ref",
      "--contains",
      branch,
      "--format=%(refname:lstrip=2)%00",
      "refs/remotes",
    ),
  )
    .map((ref) => ref.trim())
    .filter((ref) => ref !== "" && !ref.endsWith("/HEAD"));

  return refs.find((ref) => ref.endsWith(`/${branch}`)) ?? refs[0] ?? null;
}

async function cloneWithMirror(
  repository: string,
  dir: string,
  mirrors: string | undefined,
  log: Log,
): Promise<void> {
  if (mirrors === undefined) {
    await git(dirname(dir), "clone", "--", repository, dir);

    return;
  }

  const mirror = join(
    mirrors,
    `${createHash("sha256").update(repository).digest("hex").slice(0, 16)}.git`,
  );

  await inTurn(mirror, async () => {
    const reference = await updateMirror(repository, mirror).then(
      () => ["--reference", mirror, "--dissociate"],
      (error: unknown) => {
        log("mirror failed, cloning without it", {
          repository,
          mirror,
          error: String(error),
        });

        return [];
      },
    );

    await git(dirname(dir), "clone", ...reference, "--", repository, dir);
  });
}

async function updateMirror(repository: string, mirror: string): Promise<void> {
  if (await exists(mirror)) {
    await git(mirror, "fetch", "--prune", "origin");

    return;
  }

  await mkdir(dirname(mirror), { recursive: true });
  try {
    await git(dirname(mirror), "clone", "--mirror", "--", repository, mirror);
  } catch (error) {
    await rm(mirror, { recursive: true, force: true });
    throw error;
  }
}

const turns = new Map<string, Promise<unknown>>();

async function inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
  const current = (turns.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(work);

  const settled = current.catch(() => undefined);
  turns.set(key, settled);
  try {
    return await current;
  } finally {
    if (turns.get(key) === settled) {
      turns.delete(key);
    }
  }
}

// Copies the gitignored files that .worktreeinclude names, the same file and
// rules Claude Code uses: https://code.claude.com/docs/en/worktrees
async function copyIncluded(source: string, dir: string): Promise<number> {
  const top = await git(absolute(source), "rev-parse", "--show-toplevel");
  const include = join(top, ".worktreeinclude");
  if (!(await exists(include))) {
    return 0;
  }

  const included = paths(
    await git(
      top,
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      `--exclude-from=${include}`,
    ),
  );

  const ignored = new Set(
    paths(
      await git(
        top,
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
      ),
    ),
  );

  const copies = included.filter((path) =>
    ancestors(path).some((candidate) => ignored.has(candidate)),
  );

  for (const path of copies) {
    await cp(join(top, path), join(dir, path), { recursive: true });
  }

  return copies.length;
}

function paths(output: string): string[] {
  return output.split("\0").filter((path) => path !== "");
}

// A path and each directory above it, as ls-files --directory names them.
function ancestors(path: string): string[] {
  const parts = path.split("/");

  return parts.map((_, i) =>
    i === parts.length - 1 ? path : `${parts.slice(0, i + 1).join("/")}/`,
  );
}

// A fresh clone has only the default branch locally, so other branches are
// reached through the remote.
async function remoteStartPoint(
  dir: string,
  startPoint: string,
): Promise<string> {
  const remote = `origin/${startPoint}`;

  return git(
    dir,
    "rev-parse",
    "--verify",
    "--quiet",
    `${remote}^{commit}`,
  ).then(
    () => remote,
    () => startPoint,
  );
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
      maxBuffer: 64 * 1024 * 1024,
      // Under systemd there is nobody to answer a credential prompt, so git
      // must fail instead of waiting for one.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    return stdout.trim();
  } catch (error) {
    // Node names git when the directory it runs in is missing.
    if (!(await exists(cwd))) {
      throw new Error(`git ${args[0] ?? ""} failed: ${cwd} does not exist`, {
        cause: error,
      });
    }

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
