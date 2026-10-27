import type { ReactElement, ReactNode } from "react";

// Text inputs, selects and textareas share one look: a quiet border that
// darkens on hover and a soft ring on focus, as in Claude's own inputs.
export const fieldClass =
  "rounded-md border border-line bg-elevated px-3 py-2 text-ui text-fg transition-[border-color,box-shadow] duration-150 placeholder:font-sans placeholder:text-fg-dim hover:border-line-strong focus:border-line-focus focus:ring-4 focus:ring-focus focus:outline-none disabled:cursor-default disabled:opacity-60 aria-invalid:border-failed";

export function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-label font-medium text-fg">{label}</span>
      {children}
      {hint !== undefined && (
        <span className="text-caption text-fg-dim">{hint}</span>
      )}
    </label>
  );
}
