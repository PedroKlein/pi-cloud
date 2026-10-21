import type { WebPlugin } from "@pi-cloud/plugins/web";
import type { Changes } from "../src/report";

export const changes: WebPlugin = {
  name: "changes",
  sessionPanel: (element, _context, session) => {
    const panel = document.createElement("details");
    const summary = document.createElement("summary");
    const stat = document.createElement("pre");
    const patch = document.createElement("pre");
    panel.hidden = true;
    panel.append(summary, stat, patch);
    element.append(panel);

    return session.events((event) => {
      if (
        event.type !== "live" ||
        event.event.type !== "plugin" ||
        event.event.plugin !== "changes"
      ) {
        return;
      }

      const found = event.event.data as Changes;
      panel.hidden = found.files.length === 0;
      summary.textContent = `Changes (${String(found.files.length)} files)`;
      stat.textContent = found.stat;

      patch.textContent = found.truncated
        ? "The patch is too large to show."
        : found.patch;
    });
  },
};
