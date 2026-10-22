import type { ReactElement, ReactNode } from "react";

// Text inputs, selects and textareas share one look.
export const fieldClass =
  "rounded-md border border-line bg-bg px-3 py-1.5 text-ui text-fg placeholder:text-fg-dim placeholder:font-sans focus:border-accent focus:outline-none";

export function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-label font-medium text-fg-dim">{label}</span>
      {children}
    </label>
  );
}
