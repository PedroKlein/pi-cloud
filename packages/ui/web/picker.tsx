import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
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
  actions = [],
  quiet = false,
  trigger: given,
  onSearch,
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
  // Commands under the list, such as logging in, which close it.
  readonly actions?: readonly {
    readonly label: string;
    readonly run: () => void;
  }[];
  // A plain label inside a composer instead of a bordered chip.
  readonly quiet?: boolean;
  // Lets a command such as /model open the list.
  readonly trigger?: RefObject<HTMLButtonElement | null>;
  // Hears what is typed, for a list that a search somewhere else fills in.
  readonly onSearch?: (query: string) => void;
  readonly onChange: (values: readonly string[]) => void;
}): ReactElement {
  const listId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const own = useRef<HTMLButtonElement>(null);
  const trigger = given ?? own;
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const [end, setEnd] = useState(false);
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

  const search = (text: string): void => {
    setQuery(text);
    setActive(0);
    onSearch?.(text.trim());
  };

  const close = (): void => {
    setOpen(false);
    search("");
  };

  const dismiss = (): void => {
    close();
    trigger.current?.focus();
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

    search("");
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
            const { top, bottom, left, right } =
              trigger.current?.getBoundingClientRect() ?? {
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
              };

            // The list opens toward the side with more room.
            setAbove(innerHeight - bottom < top);
            setEnd(innerWidth - left < right);
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (open && placeholder === undefined) {
            keys(event);
          }
        }}
        className={cn(
          "inline-flex max-w-64 cursor-pointer items-center gap-1.5 transition-colors duration-150 hover:bg-hover aria-expanded:bg-hover",
          quiet
            ? "h-7 rounded-md px-2 text-caption text-fg-dim hover:text-fg aria-expanded:text-fg"
            : "h-8 rounded-full border border-line bg-elevated px-3 text-label text-fg shadow-xs hover:border-line-strong aria-expanded:border-line-focus",
        )}
      >
        <span className="truncate">{children}</span>
        <Icon name="chevron-down" className="size-3 shrink-0 text-fg-dim" />
      </button>
      {open && (
        <div
          className={cn(
            "absolute z-30 flex w-80 max-w-[calc(100vw-32px)] animate-pop-in flex-col gap-1 rounded-lg border border-line bg-elevated p-1.5 shadow-pop",
            above ? "bottom-full mb-1" : "top-full mt-1",
            end ? "right-0" : "left-0",
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
                search(event.target.value);
              }}
              onKeyDown={keys}
              className="h-9 rounded-md border-0 border-b border-line bg-transparent px-2 text-ui text-fg placeholder:text-fg-dim focus:outline-none"
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
                      className="block px-2 pt-2.5 pb-1 text-caption font-medium text-fg-dim"
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
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-ui transition-colors duration-100",
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
          {actions.length > 0 && (
            <div className="flex flex-col border-t border-line pt-1">
              {actions.map(({ label: action, run }) => (
                <button
                  key={action}
                  type="button"
                  onClick={() => {
                    dismiss();
                    run();
                  }}
                  className="cursor-pointer rounded-md px-2 py-1.5 text-left text-label text-fg-dim hover:bg-hover hover:text-fg"
                >
                  {action}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
