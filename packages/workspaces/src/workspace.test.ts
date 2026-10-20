import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  const cwd = await prepareWorkspace(
    { kind: "folder", path: repository },
    dir,
    noLog,
  );

  expect(cwd).toBe(repository);
  expect(stat(dir)).rejects.toThrow();
});

test("clones the repository onto the session's own branch", async () => {
  const dir = join(root, "workspaces", "s1");

  const cwd = await prepareWorkspace(
    { kind: "clone", repository, branch: "pi-cloud/s1" },
    dir,
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

  await prepareWorkspace(workspace, dir, noLog);
  await writeFile(join(dir, "notes.txt"), "work in progress\n");

  await prepareWorkspace(workspace, dir, noLog);

  expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe(
    "work in progress\n",
  );
});

test("fails with git's error and leaves no directory behind", async () => {
  const dir = join(root, "workspaces", "s1");

  const prepared = prepareWorkspace(
    { kind: "clone", repository: join(root, "missing"), branch: "pi-cloud/s1" },
    dir,
    noLog,
  );

  expect(prepared).rejects.toThrow(/does not exist|not a git repository/);
  await prepared.catch(() => undefined);
  expect(stat(dir)).rejects.toThrow();
});
