import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "./cn";
import { Icon } from "./icon";

export interface PickerOption {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
  readonly group?: string;
}

// A chip that opens a searchable list, like Claude Code's composer pickers.
// Options come grouped in the order given.
export function Picker({
  label,
  children,
  options,
  selected,
  multiple = false,
  placeholder,
  create,
  footer,
  onChange,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly options: readonly PickerOption[];
  readonly selected: readonly string[];
  readonly multiple?: boolean;
  // Shows a search box. Without it the list is short enough to scan.
  readonly placeholder?: string;
  // An option made from what was typed, such as a pasted URL.
  readonly create?: (query: string) => PickerOption | undefined;
  readonly footer?: ReactNode;
  readonly onChange: (values: readonly string[]) => void;
}): ReactElement {
  const listId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const needle = query.trim().toLowerCase();

  const matching = options.filter(
    ({ label: name, detail }) =>
      name.toLowerCase().includes(needle) ||
      (detail?.toLowerCase().includes(needle) ?? false),
  );

  const made = needle === "" ? undefined : create?.(query.trim());

  const shown =
    made && !options.some(({ value }) => value === made.value)
      ? [made, ...matching]
      : matching;

  const close = (): void => {
    setOpen(false);
    setQuery("");
    setActive(0);
  };

  const choose = (value: string): void => {
    if (!multiple) {
      onChange([value]);
      close();
      trigger.current?.focus();

      return;
    }

    onChange(
      selected.includes(value)
        ? selected.filter((known) => known !== value)
        : [...selected, value],
    );

    setQuery("");
  };

  const keys = (event: KeyboardEvent): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((index) => Math.min(index + 1, shown.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((index) => Math.max(index - 1, 0));
        break;
      case "Enter": {
        event.preventDefault();
        const option = shown[active];
        if (option) {
          choose(option.value);
        }

        break;
      }
    }
  };

  const activeId = shown[active] ? `${listId}-${String(active)}` : undefined;

  return (
    <div
      ref={wrapper}
      className="relative inline-flex"
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          // Closes the list, not the dialog around it.
          event.preventDefault();
          event.stopPropagation();
          close();
          trigger.current?.focus();
        }
      }}
      onBlur={(event) => {
        if (!(wrapper.current?.contains(event.relatedTarget) ?? false)) {
          close();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close();
          } else {
            const { top, bottom } =
              trigger.current?.getBoundingClientRect() ?? {
                top: 0,
                bottom: 0,
              };

            // The list opens toward the side with more room.
            setAbove(innerHeight - bottom < top);
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (open && placeholder === undefined) {
            keys(event);
          }
        }}
        className="inline-flex h-7 max-w-64 cursor-pointer items-center gap-1 rounded-full border border-line bg-panel px-2.5 text-caption text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent aria-expanded:border-accent"
      >
        <span className="truncate">{children}</span>
        <Icon name="chevron-down" className="size-3 shrink-0 text-fg-dim" />
      </button>
      {open && (
        <div
          className={cn(
            "absolute left-0 z-30 flex w-80 max-w-[calc(100vw-32px)] flex-col gap-1 rounded-lg border border-line bg-elevated p-1.5 shadow-pop",
            above ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {placeholder !== undefined && (
            <input
              autoFocus
              role="combobox"
              aria-label={label}
              aria-controls={listId}
              aria-expanded
              aria-activedescendant={activeId}
              value={query}
              placeholder={placeholder}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={keys}
              className="h-8 rounded-md border border-line bg-bg px-2 text-ui text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none"
            />
          )}
          <ul
            id={listId}
            role="listbox"
            aria-label={label}
            aria-multiselectable={multiple}
            className="flex max-h-72 flex-col overflow-y-auto"
          >
            {shown.length === 0 && (
              <li className="px-2 py-1.5 text-caption text-fg-dim">
                Nothing matches.
              </li>
            )}
            {shown.map((option, index) => (
              <li key={option.value} className="contents">
                {option.group !== undefined &&
                  option.group !== shown[index - 1]?.group && (
                    <span
                      aria-hidden
                      className="block px-2 pt-2 pb-0.5 text-[10px] font-semibold tracking-wider text-fg-dim uppercase"
                    >
                      {option.group}
                    </span>
                  )}
                <div
                  id={`${listId}-${String(index)}`}
                  role="option"
                  aria-selected={selected.includes(option.value)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onMouseEnter={() => {
                    setActive(index);
                  }}
                  onClick={() => {
                    choose(option.value);
                  }}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-ui",
                    index === active && "bg-hover",
                  )}
                >
                  <Icon
                    name="check"
                    className={cn(
                      "size-3.5 shrink-0 text-accent",
                      !selected.includes(option.value) && "invisible",
                    )}
                  />
                  <span
                    title={option.label}
                    className="min-w-0 flex-1 truncate text-fg"
                  >
                    {option.label}
                  </span>
                  {option.detail !== undefined && (
                    // Right to left keeps the end of a long path in view.
                    <span className="max-w-[55%] truncate text-caption text-fg-dim [direction:rtl]">
                      <bdi>{option.detail}</bdi>
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {footer !== undefined && (
            <div className="border-t border-line px-2 pt-2 pb-1 text-caption text-fg-dim">
              {footer}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
