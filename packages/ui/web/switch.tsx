import type { ReactElement } from "react";
import { cn } from "./cn";

// An on/off setting that saves when flipped, in place of a pair of buttons.
export function Switch({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-ui text-fg has-disabled:cursor-default">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => {
          onChange(!checked);
        }}
        className={cn(
          "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors duration-150 disabled:cursor-default disabled:opacity-45",
          checked ? "bg-accent" : "bg-line-strong",
        )}
      >
        <span
          className={cn(
            "size-4 rounded-full bg-elevated shadow-xs transition-transform duration-150 ease-(--ease-out)",
            checked && "translate-x-4",
          )}
        />
      </button>
      {label}
    </label>
  );
}
