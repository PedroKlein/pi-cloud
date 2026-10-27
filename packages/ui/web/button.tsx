import type { ButtonHTMLAttributes, ReactElement } from "react";
import { cn } from "./cn";

const variants = {
  default:
    "border-line bg-elevated text-fg shadow-xs hover:border-line-strong hover:bg-hover",
  primary: "border-accent bg-accent text-on-accent shadow-xs hover:opacity-90",
  ghost:
    "border-transparent bg-transparent text-fg-dim hover:bg-hover hover:text-fg",
  danger: "border-failed bg-failed-tint text-failed hover:brightness-110",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: keyof typeof variants;
  readonly iconOnly?: boolean;
}

export function Button({
  variant = "default",
  iconOnly = false,
  className,
  type = "button",
  ...props
}: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex h-control shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border text-ui font-medium whitespace-nowrap transition-[background-color,border-color,opacity,transform] duration-150 select-none active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 pointer-coarse:min-h-touch",
        iconOnly ? "w-control pointer-coarse:min-w-touch" : "px-3",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
