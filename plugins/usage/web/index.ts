import type { WebPlugin } from "@pi-cloud/plugins/web";
import { addUsage, describeUsage, type Usage } from "./usage";

export const usage: WebPlugin = {
  name: "usage",
  sessionHeader: (element, _context, session) => {
    let totals: ReadonlyMap<string, Usage> = new Map();
    let lines = 0;

    return session.events((event) => {
      if (event.type !== "entry" || event.line < lines) {
        return;
      }

      lines = event.line + 1;
      totals = addUsage(totals, event.entry);
      const { summary, detail } = describeUsage(totals);
      element.textContent = summary;
      element.title = detail;
    });
  },
};
