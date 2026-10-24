import type { SessionPlugin } from "@pi-cloud/plugins";

// The web part draws pi-subagents' runs, so it pins a version whose status
// and inspect formats it reads (ADR 0030).
export const subagents: SessionPlugin = {
  name: "subagents",
  packages: ["npm:pi-subagents@0.79.1"],
  // pi-subagents starts Pi for each run, and finds none in a compiled Pi
  // Cloud: it would run Pi Cloud's own binary with Pi's arguments.
  extension:
    ({ piCommand }) =>
    () => {
      if (piCommand !== undefined) {
        process.env["PI_SUBAGENT_PI_BINARY"] ??= piCommand;
      }
    },
};
