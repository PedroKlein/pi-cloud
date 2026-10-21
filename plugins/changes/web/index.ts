import type { WebPlugin } from "@pi-cloud/plugins/web";
import type { CheckoutChanges } from "../src/report";

export const changes: WebPlugin = {
  name: "changes",
  sessionPanel: (element, _context, session) =>
    session.events((event) => {
      if (
        event.type !== "live" ||
        event.event.type !== "plugin" ||
        event.event.plugin !== "changes"
      ) {
        return;
      }

      const found = event.event.data as readonly CheckoutChanges[];

      element.replaceChildren(
        ...found
          .filter(({ files }) => files.length > 0)
          .map((checkout) => panel(checkout)),
      );
    }),
};

function panel({
  name,
  files,
  stat,
  patch,
  truncated,
}: CheckoutChanges): HTMLDetailsElement {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const statText = document.createElement("pre");
  const patchText = document.createElement("pre");

  const label = name === "" ? "Changes" : `Changes in ${name}`;
  summary.textContent = `${label} (${String(files.length)} files)`;
  statText.textContent = stat;
  patchText.textContent = truncated ? "The patch is too large to show." : patch;
  details.append(summary, statText, patchText);

  return details;
}
