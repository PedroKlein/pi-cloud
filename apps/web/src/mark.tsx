import type { ReactElement } from "react";
import { cn } from "@pipoca/ui";

// The popped kernel (ADR 0042). Butter shows only here, so it never reads as
// a state colour; the hull follows the text.
export function Mark({
  className,
}: {
  readonly className?: string;
}): ReactElement {
  return (
    <svg
      viewBox="10 15 100 100"
      aria-hidden="true"
      className={cn("size-6 shrink-0 text-fg-strong", className)}
    >
      <g fill="#f3c552">
        <circle cx="44" cy="42" r="21" />
        <circle cx="77" cy="42" r="21" />
        <circle cx="31" cy="68" r="19" />
        <circle cx="89" cy="68" r="19" />
        <circle cx="60" cy="66" r="28" />
        <circle cx="60" cy="86" r="20" />
      </g>
      <path
        d="M49 99 C52 110 68 110 71 99 C66 95 54 95 49 99 Z"
        fill="currentColor"
      />
    </svg>
  );
}
