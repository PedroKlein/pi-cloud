import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";
import type { SessionCloud } from "@pi-cloud/plugins";
import { workspaceChanges } from "./changes";
import type { PullRequest } from "./report";

const run = promisify(execFile);

type Mode = "pr" | "draft" | "compose";

const modes: Readonly<Record<string, Mode>> = {
  "": "pr",
  draft: "draft",
  compose: "compose",
};

const describePrompt = `Write a pull request title and description for the commits and patch below.
Reply with the title alone on the first line, then a blank line, then the description in Markdown.
Keep the title under 72 characters. Describe what changed and why, not each file.`;

// The Session model's reply to a prompt, or undefined when it has no model.
export type Complete = (prompt: string) => Promise<string | undefined>;

interface Description {
  readonly title: string;
  readonly body: string;
}

type Outcome = PullRequest extends infer P
  ? P extends PullRequest
    ? Omit<P, "name">
    : never
  : never;

const pullRequestKey = (branch: string): string =>
  `branch.${branch}.piCloudPullRequest`;

// Opens the pull requests that /pr asks for, one checkout at a time, and
// publishes where each stands under "pull-requests". start is false when no
// checkout on its own session branch matches.
export function pullRequestCommand(
  { publish, checkouts, log }: SessionCloud,
  refresh: (cwd: string) => void,
): {
  readonly start: (args: string, cwd: string, complete: Complete) => boolean;
  readonly showRecorded: (cwd: string) => Promise<void>;
  readonly settled: () => Promise<void>;
} {
  const shown = new Map<string, PullRequest>();
  let opening = Promise.resolve();

  const show = (state: PullRequest): void => {
    shown.set(state.name, state);
    publish("pull-requests", [...shown.values()]);
  };

  const branches = (cwd: string) =>
    checkouts.flatMap(({ path, base }) =>
      base === null ? [] : [{ path, base, name: relative(cwd, path) }],
    );

  return {
    start: (args, cwd, complete) => {
      const { mode, only } = parsePrArgs(args);

      const targets = branches(cwd).filter(
        ({ name }) => only === undefined || name === only,
      );

      if (targets.length === 0) {
        return false;
      }

      // Commands run before the next queued message, so the push runs
      // after the handler returns instead of holding the Session.
      opening = opening.then(async () => {
        for (const { path, base, name } of targets) {
          show({ name, status: "working" });

          const started = Date.now();

          const outcome = await openPullRequest(
            path,
            base,
            mode,
            complete,
          ).catch((error: unknown): Outcome => ({
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          }));

          show({ name, ...outcome });

          log("pull request", {
            name,
            mode,
            status: outcome.status,
            ms: Date.now() - started,
          });
        }

        refresh(cwd);
      });

      return true;
    },
    showRecorded: async (cwd) => {
      for (const { path, name } of branches(cwd)) {
        const url = await recordedPullRequest(path);
        if (url !== undefined) {
          show({ name, status: "open", url });
        }
      }
    },
    settled: async () => opening,
  };
}

function parsePrArgs(args: string): {
  readonly mode: Mode;
  readonly only: string | undefined;
} {
  const [first = "", second] = args.trim().split(/\s+/);
  const mode = Object.hasOwn(modes, first) ? modes[first] : undefined;

  return mode === undefined
    ? { mode: "pr", only: first }
    : { mode, only: second };
}

// Commits what the diff view shows, pushes the session branch and opens its
// pull request (ADR 0021).
async function openPullRequest(
  path: string,
  base: string,
  mode: Mode,
  complete: Complete,
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

  if (existing !== undefined) {
    if (dirty) {
      const { title } = await described(path, base, branch, commits, complete);
      await commitAll(path, title);
    }

    await git(path, "push", "--quiet", "--set-upstream", "origin", "HEAD");

    return { status: "open", url: existing };
  }

  if (commits.length === 0 && !dirty) {
    throw new Error("nothing to push: the branch has no changes yet");
  }

  const description = await described(path, base, branch, commits, complete);

  if (dirty) {
    await commitAll(path, description.title);
  }

  await git(path, "push", "--quiet", "--set-upstream", "origin", "HEAD");

  const repository = gitHubRepository(
    await git(path, "config", "--get", "remote.origin.url").catch(() => ""),
  );

  if (repository === undefined) {
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
async function recordedPullRequest(
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

// The model's title and description for the commits and patch, or the
// commits alone when it gives none.
async function described(
  path: string,
  base: string,
  branch: string,
  commits: readonly string[],
  complete: Complete,
): Promise<Description> {
  const changes = await workspaceChanges(path, base);
  const patch = (changes?.patch ?? "").slice(0, 40_000);

  const reply = await complete(
    `${describePrompt}\n\nCommits:\n${commits.join("\n")}\n\nPatch:\n${patch}`,
  ).catch(() => undefined);

  const [title = "", ...rest] = (reply ?? "").trim().split("\n");

  if (title.trim() !== "") {
    return { title: title.trim(), body: rest.join("\n").trim() };
  }

  return {
    title: commits.length === 1 ? (commits[0] ?? branch) : branch,
    body: commits.map((subject) => `- ${subject}`).join("\n"),
  };
}

async function commitAll(path: string, message: string): Promise<void> {
  await git(path, "add", "--all");
  await git(path, "commit", "--quiet", "-m", message);
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
