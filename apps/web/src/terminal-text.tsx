import { cn } from "@pipoca/ui";
import {
  type CSSProperties,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { ansiRuns, type TextStyle } from "./ansi";

// Lines an extension rendered for Pi's TUI, drawn as the terminal shows them
// (ADR 0029).
export function TerminalText({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}): ReactElement {
  return (
    <pre
      className={cn(
        "overflow-x-hidden px-3 font-mono text-mono-sm whitespace-pre",
        className,
      )}
    >
      <Styled text={text} />
    </pre>
  );
}

export function Styled({ text }: { readonly text: string }): ReactElement {
  const runs = useMemo(() => ansiRuns(text), [text]);

  return (
    <>
      {runs.map((run, at) =>
        Object.keys(run.style).length === 0 ? (
          run.text
        ) : (
          <span key={at} style={css(run.style)}>
            {run.text}
          </span>
        ),
      )}
    </>
  );
}

const probeText = "0".repeat(10);

// Reports how many columns of TerminalText fit where it is placed.
export function TerminalColumns({
  onColumns,
}: {
  readonly onColumns: (columns: number) => void;
}): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = box.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      const char =
        (probe.current?.getBoundingClientRect().width ?? 0) / probeText.length;

      if (entry && char > 0) {
        onColumns(Math.max(1, Math.floor(entry.contentRect.width / char)));
      }
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [onColumns]);

  return (
    <div ref={box} aria-hidden className="h-0 overflow-hidden px-3">
      <span
        ref={probe}
        className="invisible font-mono text-mono-sm whitespace-pre"
      >
        {probeText}
      </span>
    </div>
  );
}

function css(style: TextStyle): CSSProperties {
  const fg = style.inverse ? (style.bg ?? "var(--bg-code)") : style.fg;
  const bg = style.inverse ? (style.fg ?? "var(--text)") : style.bg;

  return {
    color: fg,
    backgroundColor: bg,
    fontWeight: style.bold ? "bold" : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    opacity: style.dim ? 0.6 : undefined,
    textDecorationLine:
      [style.underline && "underline", style.strike && "line-through"]
        .filter(Boolean)
        .join(" ") || undefined,
  };
}
