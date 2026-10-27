import type { SessionPlugin } from "@pipoca/plugins";
import { askUserTool } from "./ask";

// ask_user replaces a user's own extension of that name, because Pipoca's
// web UI can't draw a terminal extension's custom dialogs.
export const ask: SessionPlugin = {
  name: "ask",
  tools: ({ askQuestions }) => [askUserTool(askQuestions)],
};
