import type { SessionPlugin } from "@pi-cloud/plugins";

// The web part draws pi-subagents' runs, so it pins a version whose status
// and inspect formats it reads (ADR 0030).
export const subagents: SessionPlugin = {
  name: "subagents",
  packages: ["npm:pi-subagents@0.79.1"],
};
