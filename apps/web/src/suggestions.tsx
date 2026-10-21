import { cn } from "@pi-cloud/ui";
import {
  type KeyboardEvent,
  type ReactElement,
  type SyntheticEvent,
  useRef,
  useState,
} from "react";
import type { Feed } from "./feed";
import { complete, ranked, type Trigger, trigger } from "./suggest";

const shown = 8;
const listId = "composer-suggestions";

interface Option {
  readonly value: string;
  readonly detail: string | null;
}

export interface Suggestions {
  readonly menu: ReactElement | null;
  // Props for the textarea the menu completes.
  readonly box: {
    readonly "aria-autocomplete": "list";
    readonly "aria-controls": string | undefined;
    readonly "aria-activedescendant": string | undefined;
    readonly onInput: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
    readonly onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
    readonly onBlur: () => void;
  };
  // Handles a key when the menu is open and says whether it did.
  readonly keyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

// The `/` command and `@` file menu under the composer's caret (ADR 0006).
export function useSuggestions(feed: Feed): Suggestions {
  const text = useRef<HTMLTextAreaElement>(null);
  const [typed, setTyped] = useState<Trigger>();
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number>();

  const options =
    typed === undefined || typed.from === dismissed
      ? []
      : optionsFor(typed, feed).slice(0, shown);

  const open = options.length > 0;
  const current = Math.min(active, options.length - 1);

  const refresh = (event: SyntheticEvent<HTMLTextAreaElement>): void => {
    const box = event.currentTarget;
    text.current = box;
    const next = trigger(box.value, box.selectionStart);

    if (next?.query !== typed?.query || next?.from !== typed?.from) {
      setActive(0);
    }

    if (next === undefined) {
      setDismissed(undefined);
    }

    setTyped(next);
  };

  const pick = (option: Option): void => {
    const box = text.current;
    if (!box || typed === undefined) {
      return;
    }

    const done = complete(
      box.value,
      box.selectionStart,
      typed.from,
      option.value,
    );

    box.value = done.text;
    box.setSelectionRange(done.caret, done.caret);
    box.focus();
    setTyped(undefined);
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) {
      return false;
    }

    switch (event.key) {
      case "ArrowDown":
        setActive((current + 1) % options.length);
        break;
      case "ArrowUp":
        setActive((current - 1 + options.length) % options.length);
        break;
      case "Enter":
      case "Tab": {
        const option = options[current];
        if (option) {
          pick(option);
        }

        break;
      }

      case "Escape":
        setDismissed(typed?.from);
        break;
      default:
        return false;
    }

    event.preventDefault();

    return true;
  };

  return {
    menu: open ? (
      <ul
        id={listId}
        role="listbox"
        aria-label={typed?.kind === "file" ? "Files" : "Commands"}
        className="absolute inset-x-0 bottom-full mb-2 max-h-72 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-card"
      >
        {options.map((option, index) => (
          <li
            key={option.value}
            id={`${listId}-${String(index)}`}
            role="option"
            aria-selected={index === current}
            onMouseDown={(event) => {
              event.preventDefault();
              pick(option);
            }}
            onMouseEnter={() => {
              setActive(index);
            }}
            className={cn(
              "flex cursor-pointer items-baseline gap-3 rounded-md px-3 py-1.5",
              index === current && "bg-hover",
            )}
          >
            <span className="shrink-0 font-mono text-mono-sm text-fg-strong">
              {option.value}
            </span>
            {option.detail !== null && (
              <span className="truncate text-label text-fg-dim">
                {option.detail}
              </span>
            )}
          </li>
        ))}
      </ul>
    ) : null,
    box: {
      "aria-autocomplete": "list",
      "aria-controls": open ? listId : undefined,
      "aria-activedescendant": open
        ? `${listId}-${String(current)}`
        : undefined,
      onInput: refresh,
      onSelect: refresh,
      onBlur: () => {
        setTyped(undefined);
      },
    },
    keyDown,
  };
}

function optionsFor(typed: Trigger, feed: Feed): readonly Option[] {
  switch (typed.kind) {
    case "command":
      return ranked(feed.commands, typed.query, ({ name }) => name).map(
        ({ name, description }) => ({ value: `/${name}`, detail: description }),
      );
    case "file":
      return [];
  }
}
