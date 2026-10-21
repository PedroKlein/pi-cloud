import type { ReactElement, ReactNode } from "react";

export const fieldClass =
  "rounded-md border border-line bg-bg px-3 py-1.5 text-ui text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none";

export function Actions({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}
