import type { ReactElement, SelectHTMLAttributes } from "react";
import { cn } from "./cn";
import { fieldClass } from "./field";
import { Icon } from "./icon";

// The browser's own select, for its keyboard and phone pickers, drawn as a
// field. Composer chips use Picker instead.
export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): ReactElement {
  return (
    <span className={cn("relative inline-flex min-w-0", className)}>
      <select
        className={cn(fieldClass, "w-full cursor-pointer appearance-none pr-9")}
        {...props}
      />
      <Icon
        name="chevron-down"
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-fg-dim"
      />
    </span>
  );
}
