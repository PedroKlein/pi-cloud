import { relative } from "node:path";
import type { SessionCloud, SessionPlugin } from "@pi-cloud/plugins";
import { workspaceChanges } from "./changes";
import { type Complete, pullRequestCommand } from "./pull-request";
import type { CheckoutChanges } from "./report";
export type { CheckoutChanges, PullRequest } from "./report";

// Publishes what the Session changed in each git checkout of its workspace
// when it starts and after every turn, and opens pull requests with /pr
// (ADR 0021).
export const changes: SessionPlugin = {
  name: "changes",
  extension: (cloud) => (pi) => {
    const tracked = trackChanges(cloud);
    const pullRequests = pullRequestCommand(cloud, tracked.refresh);

    pi.registerCommand("pr", {
      description:
        "Commit, push and open a pull request: /pr, /pr draft or /pr compose, then a checkout's name in a workspace of several",
      handler: async (args, ctx) => {
        const complete: Complete = async (prompt) => {
          const { model } = ctx;
          if (model === undefined) {
            return undefined;
          }

          const reply = await ctx.modelRegistry.complete(model, {
            messages: [
              { role: "user", content: prompt, timestamp: Date.now() },
            ],
          });

          return reply.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("");
        };

        if (!pullRequests.start(args, ctx.cwd, complete)) {
          ctx.ui.notify(
            "/pr needs a checkout on its own session branch.",
            "error",
          );
        }

        return Promise.resolve();
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      tracked.refresh(ctx.cwd);
      await pullRequests.showRecorded(ctx.cwd);
    });

    pi.on("agent_settled", (_event, ctx) => {
      tracked.refresh(ctx.cwd);
    });

    // Opening a pull request ends with a refresh, so it settles first.
    pi.on("session_shutdown", async () => {
      await pullRequests.settled();
      await tracked.settled();
    });
  },
};

function trackChanges({ publish, checkouts, log }: SessionCloud): {
  readonly refresh: (cwd: string) => void;
  readonly settled: () => Promise<void>;
} {
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

  return {
    refresh: (cwd) => {
      if (!queued) {
        queued = true;
        running = running.then(async () => collect(cwd));
      }
    },
    settled: async () => running,
  };
}
