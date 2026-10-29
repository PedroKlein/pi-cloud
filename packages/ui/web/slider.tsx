import { type KeyboardEvent, type ReactElement, useState } from "react";
import { cn } from "./cn";

// A row of stops to slide along, like Claude Code's effort slider: arrow
// keys or a click move it one level at a time.
export function Slider<T extends string>({
  label,
  stops,
  value,
  onChange,
}: {
  readonly label: string;
  readonly stops: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}): ReactElement {
  // A level saved elsewhere arrives after the next key press, so the slider
  // moves on from the level it last asked for until value catches up.
  const [moved, setMoved] = useState<{ readonly from: T; readonly to: T }>();
  if (moved !== undefined && moved.from !== value) {
    setMoved(undefined);
  }

  const shown = moved?.from === value ? moved.to : value;

  const at = Math.max(
    0,
    stops.findIndex((stop) => stop.value === shown),
  );

  const current = stops[at];
  const last = stops.length - 1;

  const move = (index: number): void => {
    const stop = stops[Math.min(Math.max(index, 0), last)];

    if (stop && stop.value !== shown) {
      setMoved({ from: value, to: stop.value });
      onChange(stop.value);
    }
  };

  const keys = (event: KeyboardEvent): void => {
    const next = {
      ArrowLeft: at - 1,
      ArrowDown: at - 1,
      ArrowRight: at + 1,
      ArrowUp: at + 1,
      Home: 0,
      End: last,
    }[event.key];

    if (next !== undefined) {
      event.preventDefault();
      move(next);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-caption">
        <span className="text-fg-dim">{label}</span>
        <span className="font-medium text-fg">{current?.label}</span>
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={at}
        aria-valuetext={current?.label}
        onKeyDown={keys}
        className="relative flex h-5 cursor-pointer items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-focus"
      >
        <span className="absolute inset-x-1.5 h-0.5 rounded-full bg-line-strong" />
        <span
          className="absolute left-1.5 h-0.5 rounded-full bg-accent transition-[width] duration-150 ease-(--ease-out)"
          style={{
            width:
              last === 0 ? 0 : `calc((100% - 0.75rem) * ${String(at / last)})`,
          }}
        />
        <span className="relative flex w-full justify-between">
          {stops.map((stop, index) => (
            <span
              key={stop.value}
              title={stop.label}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                move(index);
              }}
              className={cn(
                "size-3 rounded-full border-2 transition-colors duration-150",
                index <= at
                  ? "border-accent bg-accent"
                  : "border-line-strong bg-elevated",
                index === at && "scale-125",
              )}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
