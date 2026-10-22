import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { workspaceChanges } from "./changes";

const run = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "changes-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    { cwd },
  );

  return stdout.trimEnd();
}

async function repository(
  name: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const dir = join(root, name);

  await mkdir(dir);
  await git(dir, "init", "--initial-branch=main");

  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(dir, path), content);
  }

  await git(dir, "add", "--all");
  await git(dir, "commit", "-m", "first");

  return dir;
}

test("reports added, edited, deleted, renamed and mode-changed files with their patch", async () => {
  const repo = await repository("repo", {
    "edit.txt": "one\n",
    "gone.txt": "gone\n",
    "old-name.txt": "moved\n".repeat(20),
    "run.sh": "echo\n",
  });

  await writeFile(join(repo, "edit.txt"), "one\ntwo\n");
  await rm(join(repo, "gone.txt"));
  await rename(join(repo, "old-name.txt"), join(repo, "new-name.txt"));
  await chmod(join(repo, "run.sh"), 0o755);
  await writeFile(join(repo, "notes.txt"), "new notes\n");

  const changes = await workspaceChanges(repo, null);

  expect(changes?.files).toEqual([
    { status: "M", path: "edit.txt" },
    { status: "D", path: "gone.txt" },
    { status: "R", path: "new-name.txt" },
    { status: "A", path: "notes.txt" },
    { status: "M", path: "run.sh" },
  ]);

  expect(changes?.patch).toContain("+two");
  expect(changes?.patch).toContain("rename from old-name.txt");
  expect(changes?.patch).toContain("new mode 100755");
  expect(changes?.patch).toContain("+new notes");
  expect(changes?.stat).toContain("5 files changed");
  expect(changes?.truncated).toBe(false);

  expect(await git(repo, "status", "--porcelain")).toBe(
    [
      " M edit.txt",
      " D gone.txt",
      " D old-name.txt",
      " M run.sh",
      "?? new-name.txt",
      "?? notes.txt",
    ].join("\n"),
  );
});

test("leaves the contents of new and edited files out of the object store", async () => {
  const repo = await repository("repo", { "edit.txt": "one\n" });

  await writeFile(join(repo, "edit.txt"), "edited in this turn\n");
  await writeFile(join(repo, "notes.txt"), "written in this turn\n");

  const changes = await workspaceChanges(repo, null);

  expect(changes?.patch).toContain("+edited in this turn");
  expect(changes?.patch).toContain("+written in this turn");

  for (const path of ["edit.txt", "notes.txt"]) {
    const blob = await git(repo, "hash-object", path);

    const stored = await git(repo, "cat-file", "-e", blob).then(
      () => true,
      () => false,
    );

    expect({ path, stored }).toEqual({ path, stored: false });
  }
});

test("diffs against the base with the branch's commits and uncommitted work", async () => {
  const repo = await repository("repo", { "a.txt": "a\n", "b.txt": "b\n" });
  const base = await git(repo, "rev-parse", "HEAD");

  await git(repo, "switch", "-c", "pi/session");
  await writeFile(join(repo, "a.txt"), "a committed\n");
  await git(repo, "commit", "-am", "second");
  await rm(join(repo, "b.txt"));
  await writeFile(join(repo, "c.txt"), "c\n");

  const sinceBase = await workspaceChanges(repo, base);
  const sinceHead = await workspaceChanges(repo, null);

  expect(sinceBase?.files).toEqual([
    { status: "M", path: "a.txt" },
    { status: "D", path: "b.txt" },
    { status: "A", path: "c.txt" },
  ]);

  expect(sinceBase?.patch).toContain("+a committed");

  expect(sinceHead?.files).toEqual([
    { status: "D", path: "b.txt" },
    { status: "A", path: "c.txt" },
  ]);
});

test("diffs a repository with no commits against the empty tree", async () => {
  const repo = join(root, "repo");

  await mkdir(repo);
  await git(repo, "init", "--initial-branch=main");
  await writeFile(join(repo, "a.txt"), "a\n");

  const changes = await workspaceChanges(repo, null);

  expect(changes?.files).toEqual([{ status: "A", path: "a.txt" }]);
  expect(changes?.patch).toContain("+a");
});

test("shows a submodule's new commit but not the uncommitted work inside it", async () => {
  const library = await repository("library", { "lib.txt": "v1\n" });
  const repo = await repository("repo", { "README.md": "hello\n" });

  await git(repo, "submodule", "add", library, "moved");
  await git(repo, "submodule", "add", library, "dirty");
  await git(repo, "commit", "-m", "submodules");
  await writeFile(join(repo, "moved", "lib.txt"), "v2\n");
  await git(join(repo, "moved"), "commit", "-am", "v2");
  await writeFile(join(repo, "dirty", "lib.txt"), "uncommitted\n");

  const changes = await workspaceChanges(repo, null);

  expect(changes?.files).toEqual([{ status: "M", path: "moved" }]);
  expect(changes?.patch).toContain("+Subproject commit");
  expect(changes?.patch).not.toContain("-dirty");
});

test("shows a conflicted file with its conflict markers", async () => {
  const repo = await repository("repo", { "c.txt": "base\n" });

  await git(repo, "switch", "-c", "side");
  await writeFile(join(repo, "c.txt"), "side\n");
  await git(repo, "commit", "-am", "side");
  await git(repo, "switch", "main");
  await writeFile(join(repo, "c.txt"), "main\n");
  await git(repo, "commit", "-am", "main");
  await git(repo, "merge", "side").catch(() => undefined);

  const changes = await workspaceChanges(repo, null);

  expect(changes?.files).toEqual([{ status: "M", path: "c.txt" }]);
  expect(changes?.patch).toContain("+>>>>>>> side");
});
