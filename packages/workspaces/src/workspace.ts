import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
    const checkout = await prepareCheckout(workspace, options, log);

    return { cwd: checkout.path, checkouts: [checkout] };
  }

  const { dir, folders } = options;
  const { branch } = workspace;

  const repositories = workspace.repositories.map((checkout) => ({
    ...checkout,
    path: checkoutPath(dir, checkout.repository),
  }));

  await mkdir(dir, { recursive: true });

  let remotes: Promise<ReadonlyMap<string, string>> | undefined;

  // Each repository becomes a worktree of a listed folder that has it as a
  // remote, or a clone when none does. Searching the folders walks every root,
  // so it waits until a checkout is missing. A failure waits for the other
  // checkouts, so none is still writing once the workspace counts as failed.
  const settled = await Promise.allSettled(
    repositories.map(async ({ repository, path, ...start }) => {
      const folder = (await exists(path))
        ? undefined
        : (await (remotes ??= checkoutsByRemote(folders))).get(
            repositoryKey(repository),
          );

      return prepareCheckout(
        folder === undefined
          ? { kind: "clone", repository, branch, ...start }
          : { kind: "worktree", path: folder, branch, ...start },
        { ...options, dir: path },
        log,
      );
    }),
  );

  const failed = settled.find((result) => result.status === "rejected");
  if (failed !== undefined) {
    throw failed.reason;
  }

  const checkouts = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );

  return { cwd: dir, checkouts };
}

async function prepareCheckout(
  workspace: SingleWorkspace,
  options: WorkspaceOptions,
  log: Log,
): Promise<Checkout> {
  switch (workspace.kind) {
    case "folder":
      return {
        path: await allowedFolder(workspace.path, options.folders),
        base: null,
      };
    case "worktree":
      return addWorktree(workspace, options, log);
    case "clone":
      return cloneCheckout(workspace, options, log);
  }
}

async function addWorktree(
  workspace: Extract<Workspace, { kind: "worktree" }>,
  { dir, folders }: WorkspaceOptions,
  log: Log,
): Promise<Checkout> {
  const folder = await allowedFolder(workspace.path, folders);
  const { branch } = workspace;

  const reused = await reusedCheckout(dir, branch, log);
  if (reused !== undefined) {
    return reused;
  }

  if (!(await isCheckout(folder))) {
    throw new Error(
      `${workspace.path} is not a git checkout, so it can't have a worktree: start a folder session to run Pi in it directly`,
    );
  }

  log("adding worktree", { folder: workspace.path, branch, dir });

  await mkdir(dirname(dir), { recursive: true });

  const { startPoint, config } = await branchStart(folder, workspace, log);

  await git(
    folder,
    "worktree",
    "add",
    "-b",
    branch,
    dir,
    ...(startPoint === undefined ? [] : [startPoint]),
  );

  const copied = await copyIncluded(folder, dir);
  log("worktree added", { dir, copied });

  return { path: dir, base: await recordBase(dir, branch, config) };
}

async function cloneCheckout(
  workspace: Extract<Workspace, { kind: "clone" }>,
  { dir, mirrors }: WorkspaceOptions,
  log: Log,
): Promise<Checkout> {
  const { repository, branch } = workspace;

  const reused = await reusedCheckout(dir, branch, log);
  if (reused !== undefined) {
    return reused;
  }

  const partial = `${dir}.partial`;
  const started = Date.now();
  log("cloning workspace", { repository, branch, dir });

  await mkdir(dirname(dir), { recursive: true });
  await rm(partial, { recursive: true, force: true });

  const base = await cloneInto(partial, workspace, mirrors, log).catch(
    async (error: unknown) => {
      await rm(partial, { recursive: true, force: true });
      throw error;
    },
  );

  await rename(partial, dir);
  log("workspace cloned", { dir, ms: Date.now() - started });

  return { path: dir, base };
}

async function cloneInto(
  dir: string,
  workspace: Extract<Workspace, { kind: "clone" }>,
  mirrors: string | undefined,
  log: Log,
): Promise<string | null> {
  const { repository, branch } = workspace;
  await cloneWithMirror(repository, dir, mirrors, log);

  const { startPoint, config } = await branchStart(dir, workspace, log);

  await git(
    dir,
    "switch",
    "--no-track",
    "--create",
    branch,
    ...(startPoint === undefined ? [] : [startPoint]),
  );

  return recordBase(dir, branch, config);
}

interface BranchStart {
  readonly startPoint: string | undefined;
  readonly config: Readonly<Record<string, string>>;
}

// A removed session branch comes back from its restore point with its git
// config. Once no remote has that point, say after its pull request merged
// and the remote deleted it, the branch starts over like a new one, which
// still fails on a bad startPoint.
async function branchStart(
  repository: string,
  workspace: Exclude<SingleWorkspace, { kind: "folder" }>,
  log: Log,
): Promise<BranchStart> {
  const { branch, startPoint } = workspace;

  const named = (ref: string): string | Promise<string> =>
    workspace.kind === "clone" ? remoteStartPoint(repository, ref) : ref;

  if (workspace.restorePoint !== undefined) {
    const restored = await named(workspace.restorePoint);
    if (await isCommit(repository, restored)) {
      return { startPoint: restored, config: workspace.branchConfig ?? {} };
    }

    log("restore point gone, starting the branch over", {
      branch,
      restorePoint: workspace.restorePoint,
    });
  }

  return {
    startPoint: startPoint === undefined ? undefined : await named(startPoint),
    config: {},
  };
}

async function reusedCheckout(
  dir: string,
  branch: string,
  log: Log,
): Promise<Checkout | undefined> {
  if (!(await exists(dir))) {
    return undefined;
  }

  log("workspace reused", { dir });

  return { path: dir, base: await readBase(dir, branch) };
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
      const path = checkoutPath(dir, checkout.repository);
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
    const names = new Set(checkouts.map(({ path }) => basename(path)));

    const outside = (await exists(dir))
      ? (await readdir(dir)).filter((name) => !names.has(name)).sort()
      : [];

    if (outside.length > 0) {
      const reason = `files outside the repositories: ${outside.join(", ")}`;
      log("workspace kept", { dir, reason });

      return { outcome: "kept", reason };
    }

    for (const { checkout, path, workspace: single } of checkouts) {
      const reason = await lossOf(single, path, await exists(path));
      if (reason !== null) {
        log("workspace kept", { dir, reason, repository: checkout.repository });

        return {
          outcome: "kept",
          reason: `${basename(path)}: ${reason}`,
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
        ? report.restore
        : undefined;

    repositories.push({
      ...checkout,
      ...(restored?.restorePoint !== undefined && {
        restorePoint: restored.restorePoint,
      }),
      ...(restored?.branchConfig !== undefined && {
        branchConfig: restored.branchConfig,
      }),
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

  const orphaned =
    workspace.kind === "worktree" && !(await isCheckout(repository));

  const hasBranch =
    !orphaned &&
    (present || workspace.kind === "worktree") &&
    (await branchExists(repository, workspace.branch));

  if (!force) {
    const reason = await lossOf(workspace, dir, present);
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
    ? await restorePoint(repository, workspace.branch)
    : null;

  const branchConfig =
    restore === null ? {} : await piCloudConfig(repository, workspace.branch);

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
      restore === null
        ? workspace
        : { ...workspace, restorePoint: restore, branchConfig },
  };
}

async function lossOf(
  workspace: Exclude<SingleWorkspace, { kind: "folder" }>,
  dir: string,
  present: boolean,
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

  // Removing a worktree drops its HEAD and the session branch, while other
  // branches and the stash stay in the checkout it came from. Deleting a clone
  // drops its HEAD, branches and stash, whatever became of the session branch.
  if (
    workspace.kind === "worktree" &&
    present &&
    (await git(
      dir,
      "rev-list",
      "--ignore-missing",
      "HEAD",
      "--not",
      `--exclude=${workspace.branch}`,
      "--branches",
      "--remotes",
    )) !== ""
  ) {
    return "unpushed commits";
  }

  if (
    workspace.kind === "clone"
      ? !present
      : !(await branchExists(absolute(workspace.path), workspace.branch))
  ) {
    return null;
  }

  const unpushed =
    workspace.kind === "clone"
      ? await git(
          dir,
          "rev-list",
          // A clone of an empty repository has no HEAD commit yet.
          "--ignore-missing",
          "HEAD",
          "--branches",
          "refs/stash",
          "--not",
          "--remotes",
        )
      : await git(
          absolute(workspace.path),
          "rev-list",
          workspace.branch,
          "--not",
          "--remotes",
        );

  return unpushed === "" ? null : "unpushed commits";
}

async function branchExists(
  repository: string,
  branch: string,
): Promise<boolean> {
  return git(
    repository,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ).then(
    () => true,
    () => false,
  );
}

async function isCommit(repository: string, ref: string): Promise<boolean> {
  return git(
    repository,
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ).then(
    () => true,
    () => false,
  );
}

async function allowedFolder(
  path: string,
  roots: readonly string[],
): Promise<string> {
  const folder = absolute(path);
  if (!(await allowed(folder, roots))) {
    throw new Error(`folder not allowed: ${path}`);
  }

  return folder;
}

// A folder is allowed when it is a listed root or inside one. Symlinks are
// resolved first, so a link can't lead out of a root.
async function allowed(
  folder: string,
  roots: readonly string[],
): Promise<boolean> {
  const real = await realpath(folder).catch(() => undefined);
  if (real === undefined) {
    return false;
  }

  for (const root of roots) {
    const realRoot = await realpath(absolute(root)).catch(() => undefined);

    if (realRoot !== undefined && inside(realRoot, real)) {
      return true;
    }
  }

  return false;
}

function inside(root: string, folder: string): boolean {
  const fromRoot = relative(root, folder);

  return (
    fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
  );
}

const checkoutDepth = 4;
const skipped = new Set(["node_modules"]);

// The git checkouts in and under the listed roots, a few levels deep. A
// checkout's own subfolders aren't searched, but those of a folder whose .git
// is a bare repository are, since its worktrees sit there.
export async function findCheckouts(
  roots: readonly string[],
): Promise<string[]> {
  const found: string[] = [];

  const search = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

    if (
      entries.some(({ name }) => name === ".git") &&
      (await isCheckout(dir).catch(() => false))
    ) {
      found.push(dir);

      return;
    }

    if (depth === 0) {
      return;
    }

    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            !skipped.has(entry.name),
        )
        .map(async ({ name }) => search(join(dir, name), depth - 1)),
    );
  };

  await Promise.all(
    roots.map(async (root) => search(absolute(root), checkoutDepth)),
  );

  return [...new Set(found)].sort();
}

// The checkouts under the listed roots by the repositories their remotes
// name. When several checkouts have a repository, the first in sorted order
// gets it.
async function checkoutsByRemote(
  folders: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const checkouts = await Promise.all(
    (await findCheckouts(folders)).map(async (found) => {
      const folder = absolute(found);

      const urls = await git(
        folder,
        "config",
        "--get-regexp",
        "^remote\\..*\\.url$",
      ).catch(() => "");

      return { folder, urls };
    }),
  );

  const byRemote = new Map<string, string>();
  for (const { folder, urls } of checkouts) {
    const keys = urls
      .split("\n")
      .map((line) => line.slice(line.indexOf(" ") + 1))
      .filter((url) => url !== "")
      .map(repositoryKey);

    for (const key of keys) {
      if (!byRemote.has(key)) {
        byRemote.set(key, folder);
      }
    }
  }

  return byRemote;
}

// One spelling for the URLs git accepts for a repository, so that
// git@host:org/repo.git and https://host/org/repo match.
function repositoryKey(url: string): string {
  if (url.startsWith("/") || url.startsWith("~")) {
    return absolute(url)
      .replace(/\/+$/, "")
      .replace(/\.git$/, "");
  }

  const normalized = url.trim().toLowerCase();
  const scpSyntax = !normalized.includes("://");

  const key = normalized
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");

  return scpSyntax ? key.replace(/^([^/:]+):/, "$1/") : key;
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

// The session's own remote branch, or else its commit. Never another remote
// branch that holds that commit, since such a branch may have unrelated
// commits on top, or gain them before the session comes back.
async function restorePoint(
  repository: string,
  branch: string,
): Promise<string | null> {
  const tip = await git(
    repository,
    "rev-parse",
    "--verify",
    `refs/heads/${branch}`,
  );

  const refs = paths(
    await git(
      repository,
      "for-each-ref",
      "--contains",
      tip,
      "--format=%(refname:lstrip=2)%00",
      "refs/remotes",
    ),
  )
    .map((name) => name.trim())
    .filter((name) => name !== "" && !name.endsWith("/HEAD"));

  if (refs.length === 0) {
    return null;
  }

  return refs.find((name) => name.endsWith(`/${branch}`)) ?? tip;
}

async function cloneWithMirror(
  repository: string,
  dir: string,
  mirrors: string | undefined,
  log: Log,
): Promise<void> {
  if (mirrors === undefined) {
    await remoteGit(repository, dirname(dir), "clone", "--", repository, dir);

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

    await remoteGit(
      repository,
      dirname(dir),
      "clone",
      ...reference,
      "--",
      repository,
      dir,
    );
  });
}

async function updateMirror(repository: string, mirror: string): Promise<void> {
  if (await exists(mirror)) {
    await remoteGit(repository, mirror, "fetch", "--prune", "origin");

    return;
  }

  await mkdir(dirname(mirror), { recursive: true });
  try {
    await remoteGit(
      repository,
      dirname(mirror),
      "clone",
      "--mirror",
      "--",
      repository,
      mirror,
    );
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
  const top = await git(source, "rev-parse", "--show-toplevel");
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

// A restored branch gets its config back first, and keeps the base in it
// while git still has that commit.
async function recordBase(
  dir: string,
  branch: string,
  restored: Readonly<Record<string, string>>,
): Promise<string | null> {
  for (const [name, value] of Object.entries(restored)) {
    await git(dir, "config", `branch.${branch}.${name}`, value);
  }

  const kept = await readBase(dir, branch);
  if (kept !== null && (await isCommit(dir, kept))) {
    return kept;
  }

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

// The branch.<branch>.piCloud* keys by name, such as its base and the pull
// request the changes plugin opened for it. git prints them lowercased.
async function piCloudConfig(
  repository: string,
  branch: string,
): Promise<Record<string, string>> {
  const prefix = `branch.${branch}.`;

  const lines = await git(
    repository,
    "config",
    "--get-regexp",
    "^branch\\..*\\.picloud",
  ).catch(() => "");

  return Object.fromEntries(
    lines.split("\n").flatMap((line) => {
      const [, name, value] =
        /^(picloud[^.\s]*) (.*)$/.exec(line.slice(prefix.length)) ?? [];

      return line.startsWith(prefix) &&
        name !== undefined &&
        value !== undefined
        ? [[name, value]]
        : [];
    }),
  );
}

// ssh has no stall limit like http's, so these options give a server that goes
// quiet the same five minutes, unless the provider set up its own ssh command.
// A hasconfig include can set one for this repository alone.
async function remoteGit(
  repository: string,
  cwd: string,
  ...args: string[]
): Promise<string> {
  const ownSsh =
    process.env["GIT_SSH_COMMAND"] !== undefined ||
    process.env["GIT_SSH"] !== undefined ||
    (await git(
      cwd,
      "-c",
      `remote.origin.url=${repository}`,
      "config",
      "--get",
      "core.sshCommand",
    ).then(
      () => true,
      () => false,
    ));

  const ssh =
    "ssh -o ConnectTimeout=300 -o ServerAliveInterval=15 -o ServerAliveCountMax=20";

  return gitWith(ownSsh ? {} : { GIT_SSH_COMMAND: ssh }, cwd, args);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return gitWith({}, cwd, args);
}

async function gitWith(
  defaults: Readonly<Record<string, string>>,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      // Under systemd there is nobody to answer a credential prompt, so git
      // must fail instead of waiting for one. Over http it would also wait
      // forever on a server that stops sending, holding the mirror's turn.
      // The window is minutes long because a server preparing a large pack
      // sends only keepalives.
      env: {
        GIT_HTTP_LOW_SPEED_LIMIT: "1000",
        GIT_HTTP_LOW_SPEED_TIME: "300",
        ...defaults,
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
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

function checkoutPath(dir: string, repository: string): string {
  const name = checkoutName(repository);
  if (name === undefined) {
    throw new Error(`${repository} has no name for its checkout folder`);
  }

  return join(dir, name);
}

function absolute(path: string): string {
  return resolve(
    path === "~" || path.startsWith("~/")
      ? join(homedir(), path.slice(1))
      : path,
  );
}

// git's own error is kept when it refuses a repository, such as one owned by
// another user, since its message says how to fix that.
async function isCheckout(path: string): Promise<boolean> {
  const isDirectory = await stat(path).then(
    (found) => found.isDirectory(),
    () => false,
  );

  if (!isDirectory) {
    return false;
  }

  try {
    return (await git(path, "rev-parse", "--is-inside-work-tree")) === "true";
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("not a git repository")
    ) {
      return false;
    }

    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
