import { type ReactElement, useState } from "react";
import { Button } from "./button";
import { cn } from "./cn";
import { fieldClass } from "./field";
import { Icon } from "./icon";
import { isComposing } from "./keys";

// A list of short values as chips, added with Enter and removed with their x,
// in place of a textarea read one line at a time (ADR 0040).
export function ListInput({
  label,
  values,
  placeholder,
  onChange,
}: {
  readonly label: string;
  readonly values: readonly string[];
  readonly placeholder?: string;
  readonly onChange: (values: readonly string[]) => void;
}): ReactElement {
  const [draft, setDraft] = useState("");

  const add = (): void => {
    const value = draft.trim();

    if (value !== "" && !values.includes(value)) {
      onChange([...values, value]);
    }

    setDraft("");
  };

  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="pb-1.5 text-label font-medium text-fg-dim">
        {label}
      </legend>
      {values.length > 0 && (
        <ul aria-label={label} className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <li
              key={value}
              className="flex max-w-full items-center gap-1 rounded-md border border-line bg-bg py-0.5 pr-0.5 pl-2 font-mono text-mono-sm"
            >
              <span className="truncate" title={value}>
                {value}
              </span>
              <Button
                variant="ghost"
                iconOnly
                aria-label={`Remove ${value}`}
                onClick={() => {
                  onChange(values.filter((each) => each !== value));
                }}
              >
                <Icon name="x" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <input
        aria-label={`Add to ${label}`}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !isComposing(event)) {
            event.preventDefault();
            add();
          }
        }}
        onBlur={add}
        className={cn(fieldClass, "font-mono text-mono-sm")}
      />
    </fieldset>
  );
}
