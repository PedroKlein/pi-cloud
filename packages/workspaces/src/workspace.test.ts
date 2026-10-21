import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { prepareWorkspace } from "./workspace";

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
    /git worktree failed: .*not a git repository/,
  );

  await prepared.catch(() => undefined);
  expect(stat(dir)).rejects.toThrow();
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

    expect([first.base, again.base]).toEqual([start, start]);
  }

  expect(
    (
      await prepareWorkspace(
        { kind: "folder", path: repository },
        { dir: join(root, "unused"), folders: [repository] },
        noLog,
      )
    ).base,
  ).toBeNull();
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
    const { cwd, base } = await prepareWorkspace(
      workspace,
      {
        dir: join(root, "workspaces", workspace.branch),
        folders: [repository],
      },
      noLog,
    );

    expect(base).toBe(feature);
    expect(await readFile(join(cwd, "feature.txt"), "utf8")).toBe("feature\n");
    expect(await git(cwd, "branch", "--show-current")).toBe(workspace.branch);
  }
});
