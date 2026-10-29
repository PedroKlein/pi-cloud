import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useId,
  useLayoutEffect,
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

const gutter = 16;

type Row =
  | { readonly kind: "option"; readonly option: PickerOption }
  | {
      readonly kind: "group";
      readonly group: string;
      readonly count: number;
      readonly open: boolean;
    };

// A chip that opens a searchable list, like Claude Code's composer pickers.
// Options come grouped in the order given.
export function Picker({
  openGroups,
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
  chip = true,
}: {
  // Folds every other group to its name until it is opened or searched, so a
  // long list such as many providers' models stays short. A group with a
  // selected option stays open.
  readonly openGroups?: readonly string[];
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
  // Without a chip, only trigger opens the list, such as from a menu item.
  readonly chip?: boolean;
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
  const [unfolded, setUnfolded] = useState<readonly string[]>([]);
  const panel = useRef<HTMLDivElement>(null);

  // A chip in the middle of a phone screen has room on neither side, so the
  // list moves back inside the 16px gutter.
  useLayoutEffect(() => {
    const box = panel.current;
    if (box === null) {
      return;
    }

    // Measured around its centre, which the pop-in animation doesn't scale.
    const { left: scaledLeft, width } = box.getBoundingClientRect();
    const left = scaledLeft + width / 2 - box.offsetWidth / 2;
    const right = left + box.offsetWidth;

    const shift =
      left < gutter ? gutter - left : Math.min(0, innerWidth - gutter - right);

    box.style.translate = `${String(shift)}px`;
  }, [open]);

  const needle = query.trim().toLowerCase();
  const words = needle.split(/\s+/).filter((word) => word !== "");

  // Each word may match the label, the detail, the group or the value, so
  // "sap sonnet" finds a provider's model. A search shows an option listed
  // twice, such as a recent model, only where it is listed last.
  const matching = options.filter(
    (option, index) =>
      (needle === "" ||
        !options
          .slice(index + 1)
          .some(({ value }) => value === option.value)) &&
      words.every((word) =>
        [option.label, option.detail, option.group, option.value].some(
          (text) => text?.toLowerCase().includes(word) ?? false,
        ),
      ),
  );

  const made = needle === "" ? undefined : create?.(query.trim());

  const shown =
    made && !options.some(({ value }) => value === made.value)
      ? [made, ...matching]
      : matching;

  const folding = openGroups !== undefined && needle === "";

  const opened = (group: string): boolean =>
    !folding ||
    openGroups.includes(group) ||
    unfolded.includes(group) ||
    shown.some(
      (option) => option.group === group && selected.includes(option.value),
    );

  const rows: Row[] = [];

  for (const [index, option] of shown.entries()) {
    const { group } = option;

    if (folding && group !== undefined && group !== shown[index - 1]?.group) {
      rows.push({
        kind: "group",
        group,
        count: shown.filter((other) => other.group === group).length,
        open: opened(group),
      });
    }

    if (group === undefined || opened(group)) {
      rows.push({ kind: "option", option });
    }
  }

  // An opened group moves to the top of the list, so its models show even
  // when it was the last one.
  const toggle = (group: string, index: number): void => {
    const opening = !opened(group);

    setUnfolded((groups) =>
      opening ? [...groups, group] : groups.filter((known) => known !== group),
    );

    if (opening) {
      requestAnimationFrame(() => {
        document
          .getElementById(`${listId}-${String(index)}`)
          ?.scrollIntoView({ block: "start" });
      });
    }
  };

  const search = (text: string): void => {
    setQuery(text);
    setActive(0);
    onSearch?.(text.trim());
  };

  const close = (): void => {
    setOpen(false);
    setUnfolded([]);
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
        setActive((index) => Math.min(index + 1, rows.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((index) => Math.max(index - 1, 0));
        break;
      case "Enter": {
        event.preventDefault();
        const row = rows[active];
        if (row?.kind === "group") {
          toggle(row.group, active);
        } else if (row) {
          choose(row.option.value);
        }

        break;
      }
    }
  };

  const activeId = rows[active] ? `${listId}-${String(active)}` : undefined;

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
        {...(!chip && { tabIndex: -1 })}
        className={cn(
          "inline-flex max-w-64 cursor-pointer items-center gap-1.5 transition-colors duration-150 hover:bg-hover aria-expanded:bg-hover",
          !chip && "sr-only",
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
          ref={panel}
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
            {rows.map((row, index) =>
              row.kind === "group" ? (
                <li key={`group ${row.group}`} className="contents">
                  <div
                    id={`${listId}-${String(index)}`}
                    role="option"
                    aria-label={`${row.group} (${String(row.count)})`}
                    aria-selected={false}
                    aria-expanded={row.open}
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onMouseEnter={() => {
                      setActive(index);
                    }}
                    onClick={() => {
                      toggle(row.group, index);
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-caption font-medium text-fg-dim transition-colors duration-100",
                      index === active && "bg-hover text-fg",
                    )}
                  >
                    <Icon
                      name="chevron-down"
                      className={cn(
                        "size-3.5 shrink-0 transition-transform duration-150",
                        !row.open && "-rotate-90",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{row.group}</span>
                    <span className="font-normal">{row.count}</span>
                  </div>
                </li>
              ) : (
                <li
                  key={`${row.option.group ?? ""} ${row.option.value}`}
                  className="contents"
                >
                  {!folding &&
                    row.option.group !== undefined &&
                    row.option.group !== optionBefore(rows, index)?.group && (
                      <span
                        aria-hidden
                        className="block px-2 pt-2.5 pb-1 text-caption font-medium text-fg-dim"
                      >
                        {row.option.group}
                      </span>
                    )}
                  <div
                    id={`${listId}-${String(index)}`}
                    role="option"
                    aria-selected={selected.includes(row.option.value)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onMouseEnter={() => {
                      setActive(index);
                    }}
                    onClick={() => {
                      choose(row.option.value);
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-ui transition-colors duration-100",
                      folding && row.option.group !== undefined && "pl-5",
                      index === active && "bg-hover",
                    )}
                  >
                    <Icon
                      name="check"
                      className={cn(
                        "size-3.5 shrink-0 text-accent",
                        !selected.includes(row.option.value) && "invisible",
                      )}
                    />
                    <span
                      title={row.option.label}
                      className="min-w-0 flex-1 truncate text-fg"
                    >
                      {row.option.label}
                    </span>
                    {row.option.detail !== undefined && (
                      // Right to left keeps the end of a long path in view.
                      <span className="max-w-[55%] truncate text-caption text-fg-dim [direction:rtl]">
                        <bdi>{row.option.detail}</bdi>
                      </span>
                    )}
                  </div>
                </li>
              ),
            )}
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

function optionBefore(
  rows: readonly Row[],
  index: number,
): PickerOption | undefined {
  const row = rows[index - 1];

  return row?.kind === "option" ? row.option : undefined;
}
