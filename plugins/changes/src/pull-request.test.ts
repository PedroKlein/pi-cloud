import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Checkout, SessionCloud } from "@pi-cloud/plugins";
import { type Complete, pullRequestCommand } from "./pull-request";
import type { PullRequest } from "./report";

const run = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pull-request-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd },
  );

  return stdout.trimEnd();
}

// A clone on its session branch as prepareWorkspace leaves it, with the
// branch's base in its git config, and the bare repository it came from.
async function sessionCheckout(): Promise<{
  readonly origin: string;
  readonly checkout: Checkout;
}> {
  const origin = join(root, "origin.git");
  const path = join(root, "checkout");

  await git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", "--quiet", origin, path);

  // /pr commits with the checkout's own git identity.
  await git(path, "config", "user.name", "t");
  await git(path, "config", "user.email", "t@t");

  await writeFile(join(path, "README.md"), "hello\n");
  await git(path, "add", "--all");
  await git(path, "commit", "--quiet", "-m", "first");
  await git(path, "push", "--quiet", "origin", "main");

  const base = await git(path, "rev-parse", "HEAD");
  await git(path, "switch", "--quiet", "-c", "pi-cloud/session");
  await git(path, "config", "branch.pi-cloud/session.piCloudBase", base);

  return { origin, checkout: { path, base } };
}

// Runs /pr with args on the checkout and returns where its pull request ended
// up. Everything it publishes and logs on the way goes into said.
async function pr(
  checkout: Checkout,
  args: string,
  complete: Complete = async () => Promise.resolve("Edit the readme\n\nWhy."),
  said: string[] = [],
): Promise<PullRequest | undefined> {
  let outcome: PullRequest | undefined;

  const unused = (): never => {
    throw new Error("not used by /pr");
  };

  const cloud: SessionCloud = {
    publish: (_key, data) => {
      said.push(JSON.stringify(data));
      outcome = (data as readonly PullRequest[]).at(-1);
    },
    askQuestions: unused,
    checkouts: [checkout],
    settings: {},
    request: unused,
    log: (message, fields) => {
      said.push(`${message} ${JSON.stringify(fields)}`);
    },
  };

  const command = pullRequestCommand(cloud, () => undefined);
  command.start(args, checkout.path, complete);
  await command.settled();

  return outcome;
}

test("pushes the session branch as its upstream and nothing else", async () => {
  const { origin, checkout } = await sessionCheckout();

  await writeFile(join(checkout.path, "README.md"), "hello again\n");

  expect(await pr(checkout, "")).toEqual({
    name: "",
    status: "pushed",
    branch: "pi-cloud/session",
  });

  expect(await git(origin, "log", "--format=%s", "pi-cloud/session")).toBe(
    "Edit the readme\nfirst",
  );

  expect(await git(origin, "log", "--format=%s", "main")).toBe("first");

  expect(
    await git(checkout.path, "rev-parse", "--abbrev-ref", "@{upstream}"),
  ).toBe("origin/pi-cloud/session");
});

test("refuses to commit or push once the checkout has left its session branch", async () => {
  const { origin, checkout } = await sessionCheckout();

  await git(checkout.path, "switch", "--quiet", "main");
  await writeFile(join(checkout.path, "README.md"), "edited on main\n");

  expect(await pr(checkout, "")).toEqual({
    name: "",
    status: "failed",
    error: "the checkout is on main, not its session branch",
  });

  expect(await git(checkout.path, "log", "--format=%s")).toBe("first");

  expect(await git(checkout.path, "status", "--porcelain")).toBe(
    " M README.md",
  );

  expect(await git(origin, "branch", "--format=%(refname)")).toBe(
    "refs/heads/main",
  );
});

test("refuses a branch the agent made from its session branch", async () => {
  const { origin, checkout } = await sessionCheckout();

  await git(checkout.path, "switch", "--quiet", "-c", "experiment");
  await writeFile(join(checkout.path, "README.md"), "an experiment\n");

  expect(await pr(checkout, "")).toEqual({
    name: "",
    status: "failed",
    error: "the checkout is on experiment, not its session branch",
  });

  expect(await git(origin, "branch", "--format=%(refname)")).toBe(
    "refs/heads/main",
  );
});

test("refuses a detached checkout", async () => {
  const { checkout } = await sessionCheckout();

  await git(checkout.path, "switch", "--quiet", "--detach");
  await writeFile(join(checkout.path, "README.md"), "detached\n");

  expect(await pr(checkout, "")).toEqual({
    name: "",
    status: "failed",
    error: "the checkout is on a detached HEAD, not its session branch",
  });
});

// Commits a submodule at lib on the session branch, as the agent would, and
// returns its folder.
async function addLibrary({ path }: Checkout): Promise<string> {
  const library = join(root, "library");

  await git(root, "init", "--quiet", "--initial-branch=main", library);
  await writeFile(join(library, "lib.txt"), "v1\n");
  await git(library, "add", "--all");
  await git(library, "commit", "--quiet", "-m", "first");

  await git(
    path,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    library,
    "lib",
  );

  await git(path, "commit", "--quiet", "-m", "Add the library");

  return join(path, "lib");
}

test("pushes the branch's commits when the only uncommitted work is inside a submodule", async () => {
  const { origin, checkout } = await sessionCheckout();
  const lib = await addLibrary(checkout);

  await writeFile(join(lib, "lib.txt"), "edited inside\n");
  await writeFile(join(lib, "build.log"), "built\n");

  expect(await pr(checkout, "")).toEqual({
    name: "",
    status: "pushed",
    branch: "pi-cloud/session",
  });

  expect(await git(origin, "log", "--format=%s", "pi-cloud/session")).toBe(
    "Add the library\nfirst",
  );
});

test("commits a submodule moved to a new commit", async () => {
  const { origin, checkout } = await sessionCheckout();
  const lib = await addLibrary(checkout);

  await writeFile(join(lib, "lib.txt"), "v2\n");
  await git(lib, "commit", "--quiet", "-am", "v2");

  const reply = async () => Promise.resolve("Move the library\n\nWhy.");

  expect(await pr(checkout, "", reply)).toEqual({
    name: "",
    status: "pushed",
    branch: "pi-cloud/session",
  });

  expect(await git(origin, "log", "--format=%s", "pi-cloud/session")).toBe(
    "Move the library\nAdd the library\nfirst",
  );
});

test("describes a change set too large for the diff view from the head of its patch and its files", async () => {
  const { checkout } = await sessionCheckout();
  const prompts: string[] = [];

  await writeFile(
    join(checkout.path, "README.md"),
    "hello\nRetry failed uploads.\n",
  );

  await writeFile(
    join(checkout.path, "data.json"),
    Array.from({ length: 40_000 }, (_, i) => `"row ${String(i)}",`).join("\n"),
  );

  const outcome = await pr(checkout, "", async (prompt) => {
    prompts.push(prompt);

    return Promise.resolve("Retry failed uploads\n\nWhy.");
  });

  expect(outcome).toMatchObject({ status: "pushed" });

  const [prompt = ""] = prompts;

  expect(prompt).toContain("+Retry failed uploads.");
  expect(prompt).toContain("data.json");
  expect(prompt).toContain("2 files changed");
  expect(prompt.length).toBeLessThan(60_000);
});

// Points origin at remote while git still pushes to the bare repository, and
// runs /pr with args.
async function prThrough(
  remote: string,
  args: string,
): Promise<{
  readonly outcome: PullRequest | undefined;
  readonly said: string;
}> {
  const { origin, checkout } = await sessionCheckout();
  const said: string[] = [];

  await git(checkout.path, "remote", "set-url", "origin", remote);
  await git(checkout.path, "config", `url.${origin}.insteadOf`, remote);
  await writeFile(join(checkout.path, "README.md"), "hello again\n");

  const outcome = await pr(checkout, args, undefined, said);

  return { outcome, said: said.join("\n") };
}

test.each([
  "https://github.com/acme/widgets.git",
  "https://github.com/acme/widgets/",
  "git@github.com:acme/widgets.git",
  "ssh://git@github.com/acme/widgets.git",
  "ssh://git@github.com:22/acme/widgets.git",
  "https://ghp_secret@github.com/acme/widgets.git",
  "https://x-access-token:ghs_secret@github.com/acme/widgets.git",
])("composes the pull request on GitHub for %s", async (remote) => {
  const { outcome, said } = await prThrough(remote, "compose");

  expect(outcome).toMatchObject({ status: "compose", reason: null });

  const url = new URL(outcome?.status === "compose" ? outcome.url : "");

  expect(`${url.origin}${url.pathname}`).toBe(
    "https://github.com/acme/widgets/compare/pi-cloud%2Fsession",
  );

  expect(said).not.toContain("secret");
});

test("only pushes to a remote that names github.com but is elsewhere", async () => {
  const { outcome, said } = await prThrough(
    "https://github.com:secret@example.com/acme/widgets.git",
    "compose",
  );

  expect(outcome).toEqual({
    name: "",
    status: "pushed",
    branch: "pi-cloud/session",
  });

  expect(said).not.toContain("secret");
});
