import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { workspaceChanges } from "./changes";
import type { PullRequest } from "./report";

const run = promisify(execFile);

export type Mode = "pr" | "draft" | "compose";

export interface Description {
  readonly title: string;
  readonly body: string;
}

// Writes a title and description for the commits and patch, or returns
// undefined to fall back to the commits alone.
export type Describe = (
  commits: readonly string[],
  patch: string,
) => Promise<Description | undefined>;

type Outcome = PullRequest extends infer P
  ? P extends PullRequest
    ? Omit<P, "name">
    : never
  : never;

const pullRequestKey = (branch: string): string =>
  `branch.${branch}.piCloudPullRequest`;

// Commits what the diff view shows, pushes the session branch and opens its
// pull request (ADR 0021).
export async function openPullRequest(
  path: string,
  base: string,
  mode: Mode,
  describe: Describe,
): Promise<Outcome> {
  const branch = await git(path, "symbolic-ref", "--short", "HEAD").catch(
    () => {
      throw new Error("the checkout is not on a branch");
    },
  );

  const existing = await recordedPullRequest(path, branch);

  const commits = (
    await git(path, "log", "--format=%s", "--reverse", `${base}..HEAD`)
  )
    .split("\n")
    .filter((subject) => subject !== "");

  const dirty = (await git(path, "status", "--porcelain")) !== "";

  if (commits.length === 0 && !dirty && existing === undefined) {
    throw new Error("nothing to push: the branch has no changes yet");
  }

  const description =
    existing === undefined || dirty
      ? await described(path, base, branch, commits, describe)
      : undefined;

  if (dirty && description) {
    await git(path, "add", "--all");
    await git(path, "commit", "--quiet", "-m", description.title);
  }

  await git(path, "push", "--quiet", "--set-upstream", "origin", "HEAD");

  const repository = gitHubRepository(
    await git(path, "config", "--get", "remote.origin.url").catch(() => ""),
  );

  if (existing !== undefined) {
    return { status: "open", url: existing };
  }

  if (repository === undefined || description === undefined) {
    return { status: "pushed", branch };
  }

  if (mode === "compose") {
    return {
      status: "compose",
      url: composeUrl(repository, branch, description),
      reason: null,
    };
  }

  const created = await gh(path, [
    "pr",
    "create",
    "--head",
    branch,
    "--title",
    description.title,
    "--body",
    description.body,
    ...(mode === "draft" ? ["--draft"] : []),
  ]);

  const url = created.ok
    ? created.output.split("\n").find((line) => line.startsWith("https://"))
    : undefined;

  if (url === undefined) {
    return {
      status: "compose",
      url: composeUrl(repository, branch, description),
      reason: created.ok ? "gh printed no pull request link" : created.error,
    };
  }

  await git(path, "config", pullRequestKey(branch), url);

  return { status: "open", url };
}

// The pull request opened earlier for the checkout's branch, if any.
export async function recordedPullRequest(
  path: string,
  branch?: string,
): Promise<string | undefined> {
  const current =
    branch ??
    (await git(path, "symbolic-ref", "--short", "HEAD").catch(() => undefined));

  if (current === undefined) {
    return undefined;
  }

  return git(path, "config", "--get", pullRequestKey(current)).catch(
    () => undefined,
  );
}

async function described(
  path: string,
  base: string,
  branch: string,
  commits: readonly string[],
  describe: Describe,
): Promise<Description> {
  const changes = await workspaceChanges(path, base);

  const written = await describe(commits, changes?.patch ?? "").catch(
    () => undefined,
  );

  if (written) {
    return written;
  }

  return {
    title: commits.length === 1 ? (commits[0] ?? branch) : branch,
    body: commits.map((subject) => `- ${subject}`).join("\n"),
  };
}

// owner/name for a github.com remote in any of git's URL forms.
function gitHubRepository(url: string): string | undefined {
  return /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
    url,
  )?.[1];
}

function composeUrl(
  repository: string,
  branch: string,
  { title, body }: Description,
): string {
  const query = new URLSearchParams({ expand: "1", title, body });

  return `https://github.com/${repository}/compare/${encodeURIComponent(branch)}?${query.toString()}`;
}

async function gh(
  cwd: string,
  args: readonly string[],
): Promise<
  { readonly ok: true; readonly output: string } | { ok: false; error: string }
> {
  try {
    const { stdout } = await run("gh", args, {
      cwd,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });

    return { ok: true, output: stdout.trim() };
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return { ok: false, error: "gh is not installed on this machine" };
    }

    const stderr = (error as { stderr?: string }).stderr?.trim() ?? "";

    return {
      ok: false,
      error: `gh pr create failed: ${stderr === "" ? String(error) : stderr}`,
    };
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
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
