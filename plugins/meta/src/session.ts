import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionPlugin } from "@pipoca/plugins";

// tool_search only loads tools, but carries no hints.
const readers = new Set(["tool_search"]);

// A meta-session asks the user before a risky call and runs the rest straight
// away (ADR 0035). A tool without hints counts as risky.
export const metaSession: SessionPlugin = {
  name: "meta",
  ownSessionsOnly: true,
  extension: () => (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      if (!risky(pi, event.toolName)) {
        return undefined;
      }

      // The whole input, since any part of it may be what makes it risky.
      const allowed = await ctx.ui.confirm(
        `Allow ${event.toolName}?`,
        JSON.stringify(event.input, null, 2),
        ctx.signal && { signal: ctx.signal },
      );

      return allowed
        ? undefined
        : { block: true, reason: `The user didn't allow ${event.toolName}.` };
    });
  },
};

function risky(pi: ExtensionAPI, name: string): boolean {
  if (readers.has(name)) {
    return false;
  }

  const hints = pi
    .getAllTools()
    .find((tool) => tool.name === name)?.annotations;

  return !(
    hints?.readOnlyHint === true ||
    (hints?.destructiveHint === false && hints.openWorldHint === false)
  );
}
