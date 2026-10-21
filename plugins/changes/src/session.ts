import { relative } from "node:path";
import type { SessionPlugin } from "@pi-cloud/plugins";
import { workspaceChanges } from "./changes";
import type { CheckoutChanges } from "./report";
export type { CheckoutChanges } from "./report";

// Publishes what the Session changed in each git checkout of its workspace
// when it starts and after every turn.
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
              found.push({ name: relative(cwd, path), ...checkout });
            }
          } catch (error) {
            log("workspace changes failed", { path, error: String(error) });
          }
        }

        if (found.length > 0) {
          publish("changes", found);

          log("workspace changes", {
            files: found.reduce((sum, { files }) => sum + files.length, 0),
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

      pi.on("session_start", (_event, ctx) => {
        refresh(ctx.cwd);
      });

      pi.on("agent_settled", (_event, ctx) => {
        refresh(ctx.cwd);
      });

      pi.on("session_shutdown", async () => running);
    },
};
