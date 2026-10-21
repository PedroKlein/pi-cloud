import type { ButtonHTMLAttributes, ReactElement } from "react";
import { cn } from "./cn";

const variants = {
  default:
    "border-line bg-elevated text-fg hover:border-line-strong hover:bg-hover",
  primary: "border-accent bg-accent text-on-accent hover:brightness-110",
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
        "inline-flex h-control cursor-pointer items-center justify-center gap-1 rounded-md border text-ui font-medium transition-colors disabled:cursor-default disabled:opacity-50 pointer-coarse:min-h-touch",
        iconOnly ? "w-control pointer-coarse:min-w-touch" : "px-3",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
