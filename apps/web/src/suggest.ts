export interface Trigger {
  readonly kind: "command" | "file";
  readonly query: string;
  // Where the typed word starts, including its / or @.
  readonly from: number;
}

// A `/` word at the very start lists commands; an `@` word that starts the
// message or follows whitespace lists files, as in Pi's own editor.
export function trigger(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const command = /^\/(\S*)$/.exec(before);

  if (command) {
    return { kind: "command", query: command[1] ?? "", from: 0 };
  }

  const file = /(?:^|\s)@(\S*)$/.exec(before);
  const after = text.slice(caret);

  if (file && !/^\S/.test(after)) {
    const query = file[1] ?? "";

    return { kind: "file", query, from: caret - query.length - 1 };
  }

  return undefined;
}

export function ranked<T>(
  items: readonly T[],
  query: string,
  key: (item: T) => string,
): readonly T[] {
  const needle = query.toLowerCase();
  const starts: T[] = [];
  const contains: T[] = [];

  for (const item of items) {
    const name = key(item).toLowerCase();

    if (name.startsWith(needle)) {
      starts.push(item);
    } else if (name.includes(needle)) {
      contains.push(item);
    }
  }

  return [...starts, ...contains];
}

export function complete(
  text: string,
  caret: number,
  from: number,
  pick: string,
): { readonly text: string; readonly caret: number } {
  const rest = text.slice(caret);
  const inserted = rest.startsWith(" ") ? pick : `${pick} `;

  return {
    text: text.slice(0, from) + inserted + rest,
    caret: from + inserted.length + (rest.startsWith(" ") ? 1 : 0),
  };
}

// Built-in commands the browser runs itself: /copy, and /model or /thinking
// without an argument, which open their menus (ADR 0023).
export function browserCommand(
  text: string,
): "copy" | "model" | "thinking" | undefined {
  const name = /^\/(copy|model|thinking)$/.exec(text.trim())?.[1];

  return name === "copy" || name === "model" || name === "thinking"
    ? name
    : undefined;
}
