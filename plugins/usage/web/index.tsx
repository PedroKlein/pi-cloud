import type { SessionPartProps, WebPlugin } from "@pipoca/plugins/web";
import { type ReactElement, useEffect, useState } from "react";
import { addUsage, describeContext, describeUsage, type Usage } from "./usage";

export const usage: WebPlugin = {
  name: "usage",
  SessionHeader,
};

interface Context {
  readonly tokens: number | null;
  readonly window: number;
}

// A ring for how full the context is and the cost so far, like Claude Code's
// context meter. The numbers behind them show on hover.
function SessionHeader({ session }: SessionPartProps): ReactElement {
  const [totals, setTotals] = useState<ReadonlyMap<string, Usage>>(new Map());
  const [context, setContext] = useState<Context>();

  useEffect(() => {
    let lines = 0;

    return session.events((event) => {
      if (event.type === "live" && event.event.type === "context") {
        setContext({ tokens: event.event.tokens, window: event.event.window });

        return;
      }

      if (event.type !== "entry" || event.line < lines) {
        return;
      }

      lines = event.line + 1;

      setTotals((current) => addUsage(current, event.entry));
    });
  }, [session]);

  const { summary, detail, cost } = describeUsage(totals);

  const title = [
    ...(context === undefined
      ? []
      : [`${describeContext(context.tokens, context.window)} context`]),
    ...(summary === "" ? [] : [summary]),
    ...(totals.size > 1 ? [detail] : []),
  ].join("\n");

  const used =
    context?.tokens === null || context === undefined
      ? undefined
      : Math.min(context.tokens / context.window, 1);

  return (
    <span title={title} className="flex items-center gap-3 tabular-nums">
      {used !== undefined && (
        <span className="flex items-center gap-1.5">
          <Ring used={used} />
          {Math.round(used * 100)}%
        </span>
      )}
      {totals.size > 0 && <span>{cost}</span>}
    </span>
  );
}

function Ring({ used }: { readonly used: number }): ReactElement {
  const length = 2 * Math.PI * 6;

  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 -rotate-90">
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        strokeWidth="2.5"
        className="stroke-line-strong"
      />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${String(used * length)} ${String(length)}`}
        className={used > 0.8 ? "stroke-waiting" : "stroke-fg-dim"}
      />
    </svg>
  );
}
