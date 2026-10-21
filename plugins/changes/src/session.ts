import type { SessionPlugin } from "@pi-cloud/plugins";
import { workspaceChanges } from "./changes";
export type { Changes } from "./report";

// Publishes what the Session changed in its git workspace when it starts and
// after every turn.
export const changes: SessionPlugin = {
  name: "changes",
  extension:
    ({ publish, base, log }) =>
    (pi) => {
      let running = Promise.resolve();
      let queued = false;

      const collect = async (cwd: string): Promise<void> => {
        queued = false;
        const started = Date.now();
        try {
          const found = await workspaceChanges(cwd, base);
          if (found) {
            publish("changes", found);

            log("workspace changes", {
              files: found.files.length,
              truncated: found.truncated,
              ms: Date.now() - started,
            });
          }
        } catch (error) {
          log("workspace changes failed", { error: String(error) });
        }
      };

      const refresh = (cwd: string): void => {
        if (!queued) {
          queued = true;
          running = running.then(async () => collect(cwd));
        }
      };

      pi.on("session_start", (_event, ctx) => {
        refresh(ctx.cwd);
      });

      pi.on("agent_settled", (_event, ctx) => {
        refresh(ctx.cwd);
      });

      pi.on("session_shutdown", async () => running);
    },
};
