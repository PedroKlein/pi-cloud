import { relative } from "node:path";
import type { SessionPlugin } from "@pi-cloud/plugins";
import { workspaceChanges } from "./changes";
import {
  type Describe,
  type Mode,
  openPullRequest,
  recordedPullRequest,
} from "./pull-request";
import type { CheckoutChanges, PullRequest } from "./report";
export type { CheckoutChanges, PullRequest } from "./report";

const modes: Readonly<Record<string, Mode>> = {
  "": "pr",
  draft: "draft",
  compose: "compose",
};

const describePrompt = `Write a pull request title and description for the commits and patch below.
Reply with the title alone on the first line, then a blank line, then the description in Markdown.
Keep the title under 72 characters. Describe what changed and why, not each file.`;

// Publishes what the Session changed in each git checkout of its workspace
// when it starts and after every turn, and opens pull requests with /pr
// (ADR 0021).
export const changes: SessionPlugin = {
  name: "changes",
  extension:
    ({ publish, checkouts, log }) =>
    (pi) => {
      let running = Promise.resolve();
      let queued = false;

      const collect = async (cwd: string): Promise<void> => {
        queued = false;
        const started = Date.now();
        const found: CheckoutChanges[] = [];

        for (const { path, base } of checkouts) {
          try {
            const checkout = await workspaceChanges(path, base);
            if (checkout) {
              found.push({
                name: relative(cwd, path),
                branched: base !== null,
                ...checkout,
              });
            }
          } catch (error) {
            log("workspace changes failed", { path, error: String(error) });
          }
        }

        if (found.length > 0) {
          publish("changes", found);

          log("workspace changes", {
            files: found.reduce((sum, { fileCount }) => sum + fileCount, 0),
            truncated: found.some(({ truncated }) => truncated),
            ms: Date.now() - started,
          });
        }
      };

      const refresh = (cwd: string): void => {
        if (!queued) {
          queued = true;
          running = running.then(async () => collect(cwd));
        }
      };

      const pullRequests = new Map<string, PullRequest>();
      let opening = Promise.resolve();

      const show = (state: PullRequest): void => {
        pullRequests.set(state.name, state);
        publish("pull-requests", [...pullRequests.values()]);
      };

      const branches = (cwd: string) =>
        checkouts.flatMap(({ path, base }) =>
          base === null ? [] : [{ path, base, name: relative(cwd, path) }],
        );

      pi.registerCommand("pr", {
        description:
          "Commit, push and open a pull request: /pr, /pr draft or /pr compose, then a checkout's name in a workspace of several",
        handler: async (args, ctx) => {
          const { mode, only } = parsePrArgs(args);

          const targets = branches(ctx.cwd).filter(
            ({ name }) => only === undefined || name === only,
          );

          if (targets.length === 0) {
            ctx.ui.notify(
              "/pr needs a checkout on its own session branch.",
              "error",
            );

            return Promise.resolve();
          }

          const describe: Describe = async (commits, patch) => {
            const { model } = ctx;
            if (model === undefined) {
              return undefined;
            }

            const reply = await ctx.modelRegistry.complete(model, {
              messages: [
                {
                  role: "user",
                  content: `${describePrompt}\n\nCommits:\n${commits.join("\n")}\n\nPatch:\n${patch.slice(0, 40_000)}`,
                  timestamp: Date.now(),
                },
              ],
            });

            const text = reply.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("")
              .trim();

            const [title = "", ...rest] = text.split("\n");

            return title.trim() === ""
              ? undefined
              : { title: title.trim(), body: rest.join("\n").trim() };
          };

          // Commands run before the next queued message, so the push runs
          // after the handler returns instead of holding the Session.
          opening = opening.then(async () => {
            for (const { path, base, name } of targets) {
              show({ name, status: "working" });

              const started = Date.now();

              try {
                show({
                  name,
                  ...(await openPullRequest(path, base, mode, describe)),
                });
              } catch (error) {
                show({
                  name,
                  status: "failed",
                  error: error instanceof Error ? error.message : String(error),
                });
              }

              log("pull request", {
                name,
                mode,
                status: pullRequests.get(name)?.status,
                ms: Date.now() - started,
              });
            }

            refresh(ctx.cwd);
          });

          return Promise.resolve();
        },
      });

      pi.on("session_start", async (_event, ctx) => {
        refresh(ctx.cwd);

        for (const { path, name } of branches(ctx.cwd)) {
          const url = await recordedPullRequest(path);
          if (url !== undefined) {
            show({ name, status: "open", url });
          }
        }
      });

      pi.on("agent_settled", (_event, ctx) => {
        refresh(ctx.cwd);
      });

      pi.on("session_shutdown", async () => {
        await opening;
        await running;
      });
    },
};

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
