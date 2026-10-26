import type { ReactElement } from "react";
import { Button } from "./button";
import { cn } from "./cn";
import { fieldClass } from "./field";
import { Icon } from "./icon";

export interface KeyValue {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
  // A secret already saved, whose value the page never sees.
  readonly saved?: boolean;
}

// Names and values in rows, where a lock makes a row secret and pasting a
// .env into a name fills the rows (ADR 0040).
export function KeyValues({
  label,
  rows,
  onChange,
}: {
  readonly label: string;
  readonly rows: readonly KeyValue[];
  readonly onChange: (rows: readonly KeyValue[]) => void;
}): ReactElement {
  const change = (index: number, row: Partial<KeyValue>): void => {
    onChange(
      rows.map((each, at) => (at === index ? { ...each, ...row } : each)),
    );
  };

  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="pb-1.5 text-label font-medium text-fg-dim">
        {label}
      </legend>
      {rows.map((row, index) => {
        const name = row.name === "" ? `row ${String(index + 1)}` : row.name;

        return (
          <div key={index} className="flex items-center gap-1.5">
            <input
              aria-label={`Name of ${name}`}
              value={row.name}
              readOnly={row.saved}
              placeholder="NAME"
              onChange={(event) => {
                change(index, { name: event.target.value });
              }}
              onPaste={(event) => {
                const pasted = dotEnv(event.clipboardData.getData("text"));

                if (row.saved !== true && pasted.length > 0) {
                  event.preventDefault();

                  onChange([
                    ...rows.slice(0, index),
                    ...pasted.map((each) => ({ ...each, secret: row.secret })),
                    ...rows.slice(index + 1),
                  ]);
                }
              }}
              className={cn(fieldClass, "w-2/5 min-w-0 font-mono text-mono-sm")}
            />
            <input
              aria-label={`Value of ${name}`}
              type={row.secret ? "password" : "text"}
              autoComplete="off"
              value={row.value}
              placeholder={row.saved === true ? "Saved, type to replace" : ""}
              onChange={(event) => {
                change(index, { value: event.target.value });
              }}
              className={cn(
                fieldClass,
                "min-w-0 flex-1 font-mono text-mono-sm",
              )}
            />
            <Button
              variant="ghost"
              iconOnly
              aria-label={`Keep ${name} secret`}
              aria-pressed={row.secret}
              title={row.secret ? "Secret" : "Plain variable"}
              disabled={row.saved}
              onClick={() => {
                change(index, { secret: !row.secret });
              }}
            >
              <Icon name={row.secret ? "lock" : "lock-open"} />
            </Button>
            <Button
              variant="ghost"
              iconOnly
              aria-label={`Remove ${name}`}
              onClick={() => {
                onChange(rows.filter((_, at) => at !== index));
              }}
            >
              <Icon name="x" />
            </Button>
          </div>
        );
      })}
      <Button
        variant="ghost"
        className="self-start"
        onClick={() => {
          onChange([...rows, { name: "", value: "", secret: false }]);
        }}
      >
        <Icon name="plus" />
        Add
      </Button>
    </fieldset>
  );
}

// NAME=value lines, with comments, blank lines and `export ` left out and one
// layer of quotes taken off. Text without such a line is an ordinary paste.
function dotEnv(text: string): readonly KeyValue[] {
  if (!text.includes("=")) {
    return [];
  }

  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:export\s+)?([\w.-]+)\s*=(.*)$/.exec(line);

    if (match === null) {
      return [];
    }

    const [, name = "", raw = ""] = match;
    const value = raw.trim().replace(/^(["'])(.*)\1$/, "$2");

    return [{ name, value, secret: false }];
  });
}
