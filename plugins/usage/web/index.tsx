import type { SessionPartProps, WebPlugin } from "@pi-cloud/plugins/web";
import { type ReactElement, useEffect, useState } from "react";
import { addUsage, describeUsage, type Usage } from "./usage";

export const usage: WebPlugin = {
  name: "usage",
  SessionHeader,
};

function SessionHeader({ session }: SessionPartProps): ReactElement {
  const [totals, setTotals] = useState<ReadonlyMap<string, Usage>>(new Map());

  useEffect(() => {
    let lines = 0;

    return session.events((event) => {
      if (event.type !== "entry" || event.line < lines) {
        return;
      }

      lines = event.line + 1;

      setTotals((current) => addUsage(current, event.entry));
    });
  }, [session]);

  const { summary, detail } = describeUsage(totals);

  return <span title={detail}>{summary}</span>;
}
