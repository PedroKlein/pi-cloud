import type { SessionPartProps, WebPlugin } from "@pipoca/plugins/web";
import { type ReactElement, useEffect, useState } from "react";
import { addUsage, describeContext, describeUsage, type Usage } from "./usage";

export const usage: WebPlugin = {
  name: "usage",
  SessionHeader,
};

function SessionHeader({ session }: SessionPartProps): ReactElement {
  const [totals, setTotals] = useState<ReadonlyMap<string, Usage>>(new Map());
  const [context, setContext] = useState<string>();

  useEffect(() => {
    let lines = 0;

    return session.events((event) => {
      if (event.type === "live" && event.event.type === "context") {
        setContext(describeContext(event.event.tokens, event.event.window));

        return;
      }

      if (event.type !== "entry" || event.line < lines) {
        return;
      }

      lines = event.line + 1;

      setTotals((current) => addUsage(current, event.entry));
    });
  }, [session]);

  const { summary, detail } = describeUsage(totals);

  const shown = [
    ...(context === undefined ? [] : [`${context} context`]),
    ...(summary === "" ? [] : [summary]),
  ];

  return <span title={detail}>{shown.join(" · ")}</span>;
}
