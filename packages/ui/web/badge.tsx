import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";

const states = {
  working: "bg-working-tint text-working before:animate-pulse",
  waiting: "bg-waiting-tint text-waiting",
  done: "bg-done-tint text-done",
  failed: "bg-failed-tint text-failed",
  offline: "bg-hover text-fg-dim before:border before:bg-transparent",
} as const;

export type BadgeState = keyof typeof states;

export function Badge({
  state,
  children,
}: {
  readonly state: BadgeState;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-caption font-medium before:size-1.5 before:rounded-full before:bg-current",
        states[state],
      )}
    >
      {children}
    </span>
  );
}
