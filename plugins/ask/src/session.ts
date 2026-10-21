import type { SessionPlugin } from "@pi-cloud/plugins";
import { askUserTool } from "./ask";

export const ask: SessionPlugin = {
  name: "ask",
  extension:
    ({ askQuestions }) =>
    (pi) => {
      pi.registerTool(askUserTool(askQuestions));
    },
};
