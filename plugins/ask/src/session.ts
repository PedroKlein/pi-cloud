import type { SessionPlugin } from "@pi-cloud/plugins";
import { askUserTool } from "./ask";

// ask_user replaces a user's own extension of that name, because Pi Cloud's
// web UI can't draw a terminal extension's custom dialogs.
export const ask: SessionPlugin = {
  name: "ask",
  tools: ({ askQuestions }) => [askUserTool(askQuestions)],
};
