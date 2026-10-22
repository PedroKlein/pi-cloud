import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Workspace } from "@pi-cloud/protocol";
import { findCheckouts, prepareWorkspace, removeWorkspace } from "./workspace";

const run = promisify(execFile);

let root: string;
let repository: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });

  return stdout.trim();
}

const noLog = (): void => undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workspaces-"));
  repository = join(root, "origin");
  await run("git", ["init", "--initial-branch=main", repository]);
  await writeFile(join(repository, "README.md"), "hello\n");
  await git(repository, "add", ".");

  await git(
    repository,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "first",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("uses a folder workspace in place", async () => {
  const dir = join(root, "unused");

  const { cwd } = await prepareWorkspace(
    { kind: "folder", path: repository },
    { dir, folders: [repository] },
    noLog,
  );

  expect(cwd).toBe(repository);
  expect(stat(dir)).rejects.toThrow();
});

test("refuses folders the provider does not list", async () => {
  const dir = join(root, "workspaces", "s1");
  const other = join(root, "other");

  for (const workspace of [
    { kind: "folder", path: repository },
    { kind: "worktree", path: repository, branch: "pi-cloud/s1" },
  ] as const) {
    const prepared = prepareWorkspace(
      workspace,
      { dir, folders: [other] },
      noLog,
    );

    expect(prepared).rejects.toThrow(`folder not allowed: ${repository}`);
    await prepared.catch(() => undefined);
  }

  expect(stat(dir)).rejects.toThrow();
});

test("allows any folder inside a listed root", async () => {
  const nested = join(repository, "docs");
  await mkdir(nested);

  const { cwd } = await prepareWorkspace(
    { kind: "folder", path: nested },
    { dir: join(root, "unused"), folders: [root] },
    noLog,
  );

  expect(cwd).toBe(nested);
});

test("refuses a symlink inside a root that leads out of it", async () => {
  const allowedRoot = join(root, "allowed");
  await mkdir(allowedRoot);
  await symlink(repository, join(allowedRoot, "escape"));

  const prepared = prepareWorkspace(
    { kind: "folder", path: join(allowedRoot, "escape") },
    { dir: join(root, "unused"), folders: [allowedRoot] },
    noLog,
  );

  expect(prepared).rejects.toThrow("folder not allowed");
  await prepared.catch(() => undefined);
});

test("finds the checkouts under a root", async () => {
  const nested = join(root, "github.com", "org", "app");
  await mkdir(join(nested, "node_modules", "dep"), { recursive: true });
  await run("git", ["init", nested]);
  await run("git", ["init", join(nested, "node_modules", "dep")]);

  expect(await findCheckouts([root])).toEqual([nested, repository]);
});

test("finds the worktrees of a bare repository kept in a folder's .git", async () => {
  const container = join(root, "tools");
  await run("git", ["clone", "--bare", repository, join(container, ".git")]);
  await git(container, "worktree", "add", join(container, "main"), "main");

  expect(await findCheckouts([container])).toEqual([join(container, "main")]);
});

test("makes a Project repository a worktree of a checkout under a root", async () => {
  const dir = join(root, "workspaces", "s1");

  await git(
    repository,
    "remote",
    "add",
    "origin",
    "https://example.com/org/origin",
  );

  const { checkouts } = await prepareWorkspace(
    {
      kind: "repositories",
      branch: "pi-cloud/s1",
      repositories: [{ repository: "https://example.com/org/origin" }],
    },
    { dir, folders: [root] },
    noLog,
  );

  expect(checkouts).toHaveLength(1);

  expect(
    await git(checkouts[0]?.path ?? "", "rev-parse", "--git-common-dir"),
  ).toBe(join(await realpath(repository), ".git"));
});

test("matches listed folders after expanding ~ and trailing slashes", async () => {
  const home = homedir();

  const { cwd } = await prepareWorkspace(
    { kind: "folder", path: "~/" },
    { dir: join(root, "unused"), folders: [home] },
    noLog,
  );

  expect(cwd).toBe(home);
});

test("gives a worktree session its own branch outside the checkout", async () => {
  const dir = join(root, "workspaces", "s1");

  const { cwd } = await prepareWorkspace(
    { kind: "worktree", path: repository, branch: "pi-cloud/s1" },
    { dir, folders: [repository] },
    noLog,
  );

  expect(cwd).toBe(dir);
  expect(await readFile(join(dir, "README.md"), "utf8")).toBe("hello\n");
  expect(await git(dir, "branch", "--show-current")).toBe("pi-cloud/s1");
  expect(await git(repository, "branch", "--show-current")).toBe("main");

  expect(
    await git(
      repository,
      "branch",
      "--format=%(refname:short)",
      "--list",
      "pi-cloud/*",
    ),
  ).toBe("pi-cloud/s1");
});

test("keeps an existing worktree and its changes on a later attempt", async () => {
  const dir = join(root, "workspaces", "s1");
  const options = { dir, folders: [repository] };

  const workspace = {
    kind: "worktree",
    path: repository,
    branch: "pi-cloud/s1",
  } as const;

  await prepareWorkspace(workspace, options, noLog);
  await writeFile(join(dir, "notes.txt"), "work in progress\n");

  await prepareWorkspace(workspace, options, noLog);

  expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe(
    "work in progress\n",
  );
});

test("fails a worktree of a folder that is not a checkout", async () => {
  const dir = join(root, "workspaces", "s1");
  const plain = join(root, "plain");
  await mkdir(plain);

  const prepared = prepareWorkspace(
    { kind: "worktree", path: plain, branch: "pi-cloud/s1" },
    { dir, folders: [plain] },
    noLog,
  );

  expect(prepared).rejects.toThrow(
    `${plain} is not a git checkout, so it can't have a worktree: start a folder session to run Pi in it directly`,
  );

  await prepared.catch(() => undefined);
  expect(stat(dir)).rejects.toThrow();

  expect(
    await removeWorkspace(
      { kind: "worktree", path: plain, branch: "pi-cloud/s1" },
      { dir, force: false },
      noLog,
    ),
  ).toEqual({
    outcome: "removed",
    restore: { kind: "worktree", path: plain, branch: "pi-cloud/s1" },
  });
});

test("clones the repository onto the session's own branch", async () => {
  const dir = join(root, "workspaces", "s1");

  const { cwd } = await prepareWorkspace(
    { kind: "clone", repository, branch: "pi-cloud/s1" },
    { dir, folders: [] },
    noLog,
  );

  expect(cwd).toBe(dir);
  expect(await readFile(join(dir, "README.md"), "utf8")).toBe("hello\n");
  expect(await git(dir, "branch", "--show-current")).toBe("pi-cloud/s1");
  expect(await git(dir, "remote", "get-url", "origin")).toBe(repository);
});

test("keeps an existing clone and its changes on a later attempt", async () => {
  const dir = join(root, "workspaces", "s1");

  const workspace = {
    kind: "clone",
    repository,
    branch: "pi-cloud/s1",
  } as const;

  await prepareWorkspace(workspace, { dir, folders: [] }, noLog);
  await writeFile(join(dir, "notes.txt"), "work in progress\n");

  await prepareWorkspace(workspace, { dir, folders: [] }, noLog);

  expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe(
    "work in progress\n",
  );
});

test("fails with git's error and leaves no directory behind", async () => {
  const dir = join(root, "workspaces", "s1");

  const prepared = prepareWorkspace(
    { kind: "clone", repository: join(root, "missing"), branch: "pi-cloud/s1" },
    { dir, folders: [] },
    noLog,
  );

  expect(prepared).rejects.toThrow(/does not exist|not a git repository/);
  await prepared.catch(() => undefined);
  expect(stat(dir)).rejects.toThrow();
});

test("remembers the commit a session branch started from", async () => {
  const start = await git(repository, "rev-parse", "HEAD");

  for (const workspace of [
    { kind: "worktree", path: repository, branch: "pi-cloud/s1" },
    { kind: "clone", repository, branch: "pi-cloud/s2" },
  ] as const) {
    const options = {
      dir: join(root, "workspaces", workspace.branch),
      folders: [repository],
    };

    const first = await prepareWorkspace(workspace, options, noLog);
    await writeFile(join(first.cwd, "notes.txt"), "work\n");
    await git(first.cwd, "add", ".");

    await git(
      first.cwd,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-m",
      "work",
    );

    const again = await prepareWorkspace(workspace, options, noLog);

    expect([first.checkouts, again.checkouts]).toEqual([
      [{ path: first.cwd, base: start }],
      [{ path: first.cwd, base: start }],
    ]);
  }

  expect(
    (
      await prepareWorkspace(
        { kind: "folder", path: repository },
        { dir: join(root, "unused"), folders: [repository] },
        noLog,
      )
    ).checkouts,
  ).toEqual([{ path: repository, base: null }]);
});

test("starts a session branch from the branch it names", async () => {
  await git(repository, "switch", "--create", "feature");
  await writeFile(join(repository, "feature.txt"), "feature\n");
  await git(repository, "add", ".");

  await git(
    repository,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "feature",
  );

  const feature = await git(repository, "rev-parse", "HEAD");
  await git(repository, "switch", "main");

  for (const workspace of [
    {
      kind: "worktree",
      path: repository,
      branch: "pi-cloud/s1",
      startPoint: "feature",
    },
    {
      kind: "clone",
      repository,
      branch: "pi-cloud/s2",
      startPoint: "feature",
    },
    {
      kind: "clone",
      repository,
      branch: "pi-cloud/s3",
      startPoint: feature,
    },
  ] as const) {
    const { cwd, checkouts } = await prepareWorkspace(
      workspace,
      {
        dir: join(root, "workspaces", workspace.branch),
        folders: [repository],
      },
      noLog,
    );

    expect(checkouts).toEqual([{ path: cwd, base: feature }]);
    expect(await readFile(join(cwd, "feature.txt"), "utf8")).toBe("feature\n");
    expect(await git(cwd, "branch", "--show-current")).toBe(workspace.branch);
  }
});

test("clones through a mirror the clone does not depend on", async () => {
  const mirrors = join(root, "mirrors");

  const workspace = {
    kind: "clone",
    repository,
    branch: "pi-cloud/s1",
  } as const;

  const { cwd } = await prepareWorkspace(
    workspace,
    { dir: join(root, "workspaces", "s1"), folders: [], mirrors },
    noLog,
  );

  const [mirror = ""] = await readdir(mirrors);

  expect(
    await git(join(mirrors, mirror), "rev-parse", "--is-bare-repository"),
  ).toBe("true");

  expect(
    stat(join(cwd, ".git", "objects", "info", "alternates")),
  ).rejects.toThrow();

  await writeFile(join(repository, "later.txt"), "later\n");
  await git(repository, "add", ".");

  await git(
    repository,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "later",
  );

  await rm(mirrors, { recursive: true });

  expect(await git(cwd, "log", "--oneline")).toContain("first");

  const second = await prepareWorkspace(
    { ...workspace, branch: "pi-cloud/s2" },
    { dir: join(root, "workspaces", "s2"), folders: [], mirrors },
    noLog,
  );

  expect(await readFile(join(second.cwd, "later.txt"), "utf8")).toBe("later\n");
  expect(await readdir(mirrors)).toEqual([mirror]);
});

test("brings a mirror up to date before the next clone", async () => {
  const mirrors = join(root, "mirrors");

  const options = (name: string): Parameters<typeof prepareWorkspace>[1] => ({
    dir: join(root, "workspaces", name),
    folders: [],
    mirrors,
  });

  await prepareWorkspace(
    { kind: "clone", repository, branch: "pi-cloud/s1" },
    options("s1"),
    noLog,
  );

  await writeFile(join(repository, "later.txt"), "later\n");
  await git(repository, "add", ".");

  await git(
    repository,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "later",
  );

  const later = await git(repository, "rev-parse", "HEAD");

  await prepareWorkspace(
    { kind: "clone", repository, branch: "pi-cloud/s2" },
    options("s2"),
    noLog,
  );

  const [mirror = ""] = await readdir(mirrors);

  expect(await git(join(mirrors, mirror), "rev-parse", "main")).toBe(later);
});

test("clones without a mirror when the mirror cannot be made", async () => {
  const mirrors = join(root, "mirrors");
  await writeFile(mirrors, "not a directory\n");
  const logs: string[] = [];

  const { cwd } = await prepareWorkspace(
    { kind: "clone", repository, branch: "pi-cloud/s1" },
    { dir: join(root, "workspaces", "s1"), folders: [], mirrors },
    (message) => {
      logs.push(message);
    },
  );

  expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("hello\n");
  expect(logs).toContain("mirror failed, cloning without it");
});

test("clones the same repository for several sessions at once", async () => {
  const mirrors = join(root, "mirrors");

  const prepared = await Promise.all(
    ["s1", "s2", "s3"].map(async (name) =>
      prepareWorkspace(
        { kind: "clone", repository, branch: `pi-cloud/${name}` },
        { dir: join(root, "workspaces", name), folders: [], mirrors },
        noLog,
      ),
    ),
  );

  for (const { cwd } of prepared) {
    expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("hello\n");
  }

  expect(await readdir(mirrors)).toHaveLength(1);
});

test("gives up on a repository whose server stops sending", async () => {
  const connections: Socket[] = [];

  const server = createServer((socket) => {
    connections.push(socket);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;
  const silent = `http://127.0.0.1:${String(port)}/repo.git`;
  const mirrors = join(root, "mirrors");
  const lowSpeedTime = process.env["GIT_HTTP_LOW_SPEED_TIME"];
  process.env["GIT_HTTP_LOW_SPEED_TIME"] = "1";

  try {
    const prepared = await Promise.allSettled(
      ["s1", "s2"].map(async (name) =>
        prepareWorkspace(
          { kind: "clone", repository: silent, branch: `pi-cloud/${name}` },
          { dir: join(root, "workspaces", name), folders: [], mirrors },
          noLog,
        ),
      ),
    );

    for (const result of prepared) {
      expect(
        result.status === "rejected" ? String(result.reason) : "cloned",
      ).toContain("Operation too slow");
    }

    expect(connections.length).toBeGreaterThan(0);
  } finally {
    if (lowSpeedTime === undefined) {
      delete process.env["GIT_HTTP_LOW_SPEED_TIME"];
    } else {
      process.env["GIT_HTTP_LOW_SPEED_TIME"] = lowSpeedTime;
    }

    for (const connection of connections) {
      connection.destroy();
    }

    server.close();
  }
}, 30_000);

test("copies the gitignored files .worktreeinclude names into a new worktree", async () => {
  await writeFile(join(repository, ".gitignore"), ".env\nsecrets/\nbuild/\n");

  await writeFile(
    join(repository, ".worktreeinclude"),
    ".env\nsecrets/\nnotes.txt\n",
  );

  await git(repository, "add", ".");

  await git(
    repository,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "ignore",
  );

  await writeFile(join(repository, ".env"), "KEY=1\n");
  await mkdir(join(repository, "secrets", "nested"), { recursive: true });
  await writeFile(join(repository, "secrets", "nested", "key.pem"), "pem\n");
  await mkdir(join(repository, "build"));
  await writeFile(join(repository, "build", "out.js"), "built\n");
  await writeFile(join(repository, "notes.txt"), "untracked, not ignored\n");
  const dir = join(root, "workspaces", "s1");

  await prepareWorkspace(
    { kind: "worktree", path: repository, branch: "pi-cloud/s1" },
    { dir, folders: [repository] },
    noLog,
  );

  expect(await readFile(join(dir, ".env"), "utf8")).toBe("KEY=1\n");

  expect(
    await readFile(join(dir, "secrets", "nested", "key.pem"), "utf8"),
  ).toBe("pem\n");

  expect(stat(join(dir, "build"))).rejects.toThrow();
  expect(stat(join(dir, "notes.txt"))).rejects.toThrow();
  expect(await git(dir, "status", "--porcelain")).toBe("");
});

test("copies nothing into a worktree without .worktreeinclude", async () => {
  await writeFile(join(repository, ".gitignore"), ".env\n");
  await git(repository, "add", ".");

  await git(
    repository,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "ignore",
  );

  await writeFile(join(repository, ".env"), "KEY=1\n");
  const dir = join(root, "workspaces", "s1");

  await prepareWorkspace(
    { kind: "worktree", path: repository, branch: "pi-cloud/s1" },
    { dir, folders: [repository] },
    noLog,
  );

  expect(stat(join(dir, ".env"))).rejects.toThrow();
});

async function commit(cwd: string, file: string): Promise<void> {
  await writeFile(join(cwd, file), `${file}\n`);
  await git(cwd, "add", ".");

  await git(
    cwd,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    file,
  );
}

async function checkoutWithRemote(): Promise<string> {
  const checkout = join(root, "checkout");
  await git(root, "clone", repository, checkout);

  return checkout;
}

test("removes a clean worktree and its branch and brings it back from the pushed branch", async () => {
  const checkout = await checkoutWithRemote();
  const dir = join(root, "workspaces", "s1");
  const options = { dir, folders: [checkout] };

  const workspace = {
    kind: "worktree",
    path: checkout,
    branch: "pi-cloud/s1",
  } as const;

  await prepareWorkspace(workspace, options, noLog);
  await commit(dir, "work.txt");
  await git(dir, "push", "origin", "pi-cloud/s1");

  const report = await removeWorkspace(workspace, { dir, force: false }, noLog);

  expect(report).toEqual({
    outcome: "removed",
    restore: { ...workspace, startPoint: "origin/pi-cloud/s1" },
  });

  expect(stat(dir)).rejects.toThrow();
  expect(await git(checkout, "branch", "--list", "pi-cloud/s1")).toBe("");
  expect(await git(checkout, "worktree", "list")).not.toContain(dir);

  await prepareWorkspace(
    { ...workspace, startPoint: "origin/pi-cloud/s1" },
    options,
    noLog,
  );

  expect(await readFile(join(dir, "work.txt"), "utf8")).toBe("work.txt\n");
  expect(await git(dir, "branch", "--show-current")).toBe("pi-cloud/s1");
});

test("keeps a worktree with work git would lose unless forced", async () => {
  const checkout = await checkoutWithRemote();

  const losses = [
    {
      reason: "uncommitted changes",
      make: async (dir: string) =>
        writeFile(join(dir, "README.md"), "edited\n"),
    },
    {
      reason: "uncommitted changes",
      make: async (dir: string) => writeFile(join(dir, "new.txt"), "new\n"),
    },
    {
      reason: "unpushed commits",
      make: async (dir: string) => commit(dir, "local.txt"),
    },
  ];

  for (const [i, { reason, make }] of losses.entries()) {
    const dir = join(root, "workspaces", `s${String(i)}`);

    const workspace = {
      kind: "worktree",
      path: checkout,
      branch: `pi-cloud/s${String(i)}`,
    } as const;

    await prepareWorkspace(workspace, { dir, folders: [checkout] }, noLog);
    await make(dir);

    expect(
      await removeWorkspace(workspace, { dir, force: false }, noLog),
    ).toEqual({
      outcome: "kept",
      reason,
    });

    expect((await stat(dir)).isDirectory()).toBe(true);

    expect(
      (await removeWorkspace(workspace, { dir, force: true }, noLog)).outcome,
    ).toBe("removed");

    expect(stat(dir)).rejects.toThrow();
    expect(await git(checkout, "branch", "--list", workspace.branch)).toBe("");
  }
});

test("removes a clean clone and keeps one with unpushed commits", async () => {
  const workspace = {
    kind: "clone",
    repository,
    branch: "pi-cloud/s1",
  } as const;

  const clean = join(root, "workspaces", "clean");
  await prepareWorkspace(workspace, { dir: clean, folders: [] }, noLog);
  await mkdir(join(clean, "build"));
  await writeFile(join(clean, ".git", "info", "exclude"), "build/\n");
  await writeFile(join(clean, "build", "out.js"), "built\n");

  expect(
    await removeWorkspace(workspace, { dir: clean, force: false }, noLog),
  ).toEqual({
    outcome: "removed",
    restore: { ...workspace, startPoint: "origin/main" },
  });

  expect(stat(clean)).rejects.toThrow();

  const dirty = join(root, "workspaces", "dirty");
  await prepareWorkspace(workspace, { dir: dirty, folders: [] }, noLog);
  await commit(dirty, "local.txt");

  expect(
    await removeWorkspace(workspace, { dir: dirty, force: false }, noLog),
  ).toEqual({ outcome: "kept", reason: "unpushed commits" });

  expect(
    await removeWorkspace(workspace, { dir: dirty, force: true }, noLog),
  ).toEqual({ outcome: "removed", restore: workspace });

  expect(stat(dirty)).rejects.toThrow();
});

test("keeps a clone with unpushed commits off its session branch unless forced", async () => {
  const workspace = {
    kind: "clone",
    repository,
    branch: "pi-cloud/s1",
  } as const;

  const losses = [
    async (dir: string) => {
      await git(dir, "branch", "--move", "pi-cloud/s1", "feat/x");
      await commit(dir, "renamed.txt");
    },
    async (dir: string) => {
      await git(dir, "switch", "--create", "feat/y");
      await commit(dir, "other.txt");
      await git(dir, "branch", "--delete", "--force", "pi-cloud/s1");
    },
    async (dir: string) => {
      await git(dir, "switch", "--detach");
      await commit(dir, "detached.txt");
    },
  ];

  for (const [i, make] of losses.entries()) {
    const dir = join(root, "workspaces", `s${String(i)}`);
    await prepareWorkspace(workspace, { dir, folders: [] }, noLog);
    await make(dir);

    expect(
      await removeWorkspace(workspace, { dir, force: false }, noLog),
    ).toEqual({ outcome: "kept", reason: "unpushed commits" });

    expect((await stat(dir)).isDirectory()).toBe(true);

    expect(
      (await removeWorkspace(workspace, { dir, force: true }, noLog)).outcome,
    ).toBe("removed");

    expect(stat(dir)).rejects.toThrow();
  }
});

test("removes a clean clone of an empty repository", async () => {
  const empty = join(root, "empty.git");
  await run("git", ["init", "--bare", empty]);

  const workspace = {
    kind: "clone",
    repository: empty,
    branch: "pi-cloud/s1",
  } as const;

  const dir = join(root, "workspaces", "s1");
  await prepareWorkspace(workspace, { dir, folders: [] }, noLog);

  expect(
    await removeWorkspace(workspace, { dir, force: false }, noLog),
  ).toEqual({ outcome: "removed", restore: workspace });

  expect(stat(dir)).rejects.toThrow();
});

async function removeAndRestore(
  workspace: Workspace,
  options: { readonly dir: string; readonly folders: readonly string[] },
): Promise<void> {
  const report = await removeWorkspace(
    workspace,
    { dir: options.dir, force: false },
    noLog,
  );

  if (report.outcome === "kept") {
    throw new Error(`workspace kept: ${report.reason}`);
  }

  await prepareWorkspace(report.restore, options, noLog);
}

test("brings a session back without the commits of another remote branch that contains it", async () => {
  await git(repository, "switch", "--create", "aaa-feature");
  await commit(repository, "unrelated.txt");
  await git(repository, "switch", "main");
  const checkout = await checkoutWithRemote();

  for (const workspace of [
    { kind: "clone", repository, branch: "pi-cloud/s1" },
    { kind: "worktree", path: checkout, branch: "pi-cloud/s2" },
  ] as const) {
    const dir = join(root, "workspaces", workspace.branch);
    const options = { dir, folders: [checkout] };
    await prepareWorkspace(workspace, options, noLog);
    const tip = await git(dir, "rev-parse", "HEAD");

    await removeAndRestore(workspace, options);

    expect(await git(dir, "rev-parse", "HEAD")).toBe(tip);
    expect(await readdir(dir)).not.toContain("unrelated.txt");
  }
});

test("brings a session back at its own commit once the branch holding it moved on", async () => {
  const checkout = await checkoutWithRemote();

  for (const workspace of [
    { kind: "clone", repository, branch: "pi-cloud/s1" },
    { kind: "worktree", path: checkout, branch: "pi-cloud/s2" },
  ] as const) {
    const dir = join(root, "workspaces", workspace.branch);
    const options = { dir, folders: [checkout] };
    const review = `review/${workspace.kind}`;
    await prepareWorkspace(workspace, options, noLog);
    await commit(dir, "work.txt");
    await git(dir, "push", "origin", `HEAD:refs/heads/${review}`);
    const tip = await git(dir, "rev-parse", "HEAD");

    await git(repository, "switch", review);
    await commit(repository, "later.txt");
    await git(repository, "switch", "main");
    await git(dir, "fetch", "origin");

    await removeAndRestore(workspace, options);

    expect(await git(dir, "rev-parse", "HEAD")).toBe(tip);
    expect(await readdir(dir)).not.toContain("later.txt");
  }
});

test("reports a workspace that is already gone as removed", async () => {
  const checkout = await checkoutWithRemote();

  for (const workspace of [
    { kind: "worktree", path: checkout, branch: "pi-cloud/s1" },
    { kind: "clone", repository, branch: "pi-cloud/s2" },
  ] as const) {
    const dir = join(root, "workspaces", workspace.branch);

    expect(
      await removeWorkspace(workspace, { dir, force: false }, noLog),
    ).toEqual({ outcome: "removed", restore: workspace });
  }
});

test("removes a worktree whose checkout is gone only when forced", async () => {
  const checkout = await checkoutWithRemote();
  const dir = join(root, "workspaces", "s1");

  const workspace = {
    kind: "worktree",
    path: checkout,
    branch: "pi-cloud/s1",
  } as const;

  await prepareWorkspace(workspace, { dir, folders: [checkout] }, noLog);
  await rm(checkout, { recursive: true, force: true });

  expect(
    await removeWorkspace(workspace, { dir, force: false }, noLog),
  ).toEqual({
    outcome: "kept",
    reason: "the folder it was checked out from is gone",
  });

  expect(await removeWorkspace(workspace, { dir, force: true }, noLog)).toEqual(
    { outcome: "removed", restore: workspace },
  );

  expect(stat(dir)).rejects.toThrow();

  const several = {
    kind: "repositories",
    branch: "pi-cloud/s2",
    repositories: [{ repository }],
  } as const;

  const again = await checkoutWithRemote();
  const other = join(root, "workspaces", "s2");
  await prepareWorkspace(several, { dir: other, folders: [again] }, noLog);
  await rm(again, { recursive: true, force: true });

  expect(
    await removeWorkspace(several, { dir: other, force: false }, noLog),
  ).toEqual({
    outcome: "kept",
    reason: "origin: the folder it was checked out from is gone",
  });
});

test("never removes a folder workspace", async () => {
  expect(
    (
      await removeWorkspace(
        { kind: "folder", path: repository },
        { dir: repository, force: true },
        noLog,
      )
    ).outcome,
  ).toBe("kept");

  expect(await readFile(join(repository, "README.md"), "utf8")).toBe("hello\n");
});

async function repositoryAt(path: string): Promise<void> {
  await run("git", ["init", "--initial-branch=main", path]);
  await commit(path, "README.md");
}

test("checks several repositories out side by side on the session's branch", async () => {
  const second = join(root, "second");
  await repositoryAt(second);
  const checkout = await checkoutWithRemote();
  await git(checkout, "remote", "set-url", "origin", `${repository}/`);

  const dir = join(root, "workspaces", "s1");

  const workspace = {
    kind: "repositories",
    branch: "pi-cloud/s1",
    repositories: [{ repository }, { repository: second }],
  } as const;

  const { cwd, checkouts } = await prepareWorkspace(
    workspace,
    { dir, folders: [checkout] },
    noLog,
  );

  expect(cwd).toBe(dir);

  expect(checkouts.map(({ path }) => path)).toEqual([
    join(dir, "origin"),
    join(dir, "second"),
  ]);

  for (const { path, base } of checkouts) {
    expect(await git(path, "branch", "--show-current")).toBe("pi-cloud/s1");
    expect(base).toBe(await git(path, "rev-parse", "HEAD"));
  }

  expect(await git(checkout, "worktree", "list")).toContain(
    join(dir, "origin"),
  );

  expect((await stat(join(dir, "second", ".git"))).isDirectory()).toBe(true);

  const again = await prepareWorkspace(
    workspace,
    { dir, folders: [checkout] },
    noLog,
  );

  expect(again.checkouts).toEqual(checkouts);
});

test("matches a folder whose remote names the repository another way", async () => {
  const checkout = await checkoutWithRemote();

  await git(
    checkout,
    "remote",
    "set-url",
    "origin",
    "git@github.com:Example/Tool.git",
  );

  const dir = join(root, "workspaces", "s1");

  await prepareWorkspace(
    {
      kind: "repositories",
      branch: "pi-cloud/s1",
      repositories: [{ repository: "https://github.com/example/tool" }],
    },
    { dir, folders: [checkout] },
    noLog,
  );

  expect(await git(checkout, "worktree", "list")).toContain(join(dir, "tool"));
});

test("matches a folder whose scp-style remote path starts with a digit", async () => {
  const checkout = await checkoutWithRemote();

  await git(
    checkout,
    "remote",
    "set-url",
    "origin",
    "git@git.example.com:3b1b/Manim.git",
  );

  const dir = join(root, "workspaces", "s1");

  await prepareWorkspace(
    {
      kind: "repositories",
      branch: "pi-cloud/s1",
      repositories: [{ repository: "https://git.example.com/3b1b/manim" }],
    },
    { dir, folders: [checkout] },
    noLog,
  );

  expect(await git(checkout, "worktree", "list")).toContain(join(dir, "manim"));
});

test("removes several repositories only when none of them would lose work", async () => {
  const second = join(root, "second");
  await repositoryAt(second);
  const checkout = await checkoutWithRemote();
  const dir = join(root, "workspaces", "s1");
  const options = { dir, folders: [checkout] };

  const workspace = {
    kind: "repositories",
    branch: "pi-cloud/s1",
    repositories: [{ repository }, { repository: second }],
  } as const;

  await prepareWorkspace(workspace, options, noLog);
  await writeFile(join(dir, "second", "draft.txt"), "draft\n");

  expect(
    await removeWorkspace(workspace, { dir, force: false }, noLog),
  ).toEqual({ outcome: "kept", reason: "second: uncommitted changes" });

  expect((await stat(join(dir, "origin"))).isDirectory()).toBe(true);

  await rm(join(dir, "second", "draft.txt"));
  await commit(join(dir, "origin"), "work.txt");
  await git(join(dir, "origin"), "push", "origin", "pi-cloud/s1");

  const report = await removeWorkspace(workspace, { dir, force: false }, noLog);

  expect(report).toEqual({
    outcome: "removed",
    restore: {
      ...workspace,
      repositories: [
        { repository, startPoint: "origin/pi-cloud/s1" },
        { repository: second, startPoint: "origin/main" },
      ],
    },
  });

  expect(stat(dir)).rejects.toThrow();
  expect(await git(checkout, "branch", "--list", "pi-cloud/s1")).toBe("");

  if (report.outcome === "removed") {
    await prepareWorkspace(report.restore, options, noLog);
  }

  expect(await readFile(join(dir, "origin", "work.txt"), "utf8")).toBe(
    "work.txt\n",
  );
});

test("keeps several repositories while files sit beside them", async () => {
  const dir = join(root, "workspaces", "s1");

  const workspace = {
    kind: "repositories",
    branch: "pi-cloud/s1",
    repositories: [{ repository }],
  } as const;

  await prepareWorkspace(workspace, { dir, folders: [] }, noLog);
  await writeFile(join(dir, "out.txt"), "result\n");

  expect(
    await removeWorkspace(workspace, { dir, force: false }, noLog),
  ).toEqual({
    outcome: "kept",
    reason: "files outside the repositories: out.txt",
  });

  expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("result\n");

  expect(
    (await removeWorkspace(workspace, { dir, force: true }, noLog)).outcome,
  ).toBe("removed");

  expect(stat(dir)).rejects.toThrow();
});

test("refuses a repository whose URL leaves no name for its folder", async () => {
  const dir = join(root, "workspaces", "s1");
  const unnamed = join(repository, ".git");

  const prepared = prepareWorkspace(
    {
      kind: "repositories",
      branch: "pi-cloud/s1",
      repositories: [{ repository: unnamed }],
    },
    { dir, folders: [] },
    noLog,
  );

  expect(prepared).rejects.toThrow(
    `${unnamed} has no name for its checkout folder`,
  );

  await prepared.catch(() => undefined);

  expect(stat(dir)).rejects.toThrow();
});

test("never removes the folder above a workspace, even when forced", async () => {
  const workspaces = join(root, "workspaces");
  const dir = join(workspaces, "s1");
  const draft = join(workspaces, "s2", "draft.txt");
  await mkdir(dir, { recursive: true });
  await mkdir(join(workspaces, "s2"));
  await writeFile(draft, "draft\n");

  const removed = removeWorkspace(
    {
      kind: "repositories",
      branch: "pi-cloud/s1",
      repositories: [{ repository: "https://example.com/org/.." }],
    },
    { dir, force: true },
    noLog,
  );

  expect(removed).rejects.toThrow(
    "https://example.com/org/.. has no name for its checkout folder",
  );

  await removed.catch(() => undefined);

  expect(await readFile(draft, "utf8")).toBe("draft\n");
});
