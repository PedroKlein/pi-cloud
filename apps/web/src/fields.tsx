import type { ReactElement, ReactNode } from "react";

export function Actions({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}
