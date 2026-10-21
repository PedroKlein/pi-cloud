export type ChatItem =
  | {
      readonly role: "user" | "assistant" | "error" | "note";
      readonly text: string;
    }
  | {
      readonly role: "tool";
      readonly id: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly role: "result";
      readonly id: string;
      readonly name: string;
      readonly text: string;
      readonly failed: boolean;
    };

interface Part {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: unknown;
}

interface Entry {
  readonly type: string;
  readonly content?: unknown;
  readonly display?: boolean;
  readonly message?: {
    readonly role: string;
    readonly content: string | readonly Part[];
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly isError?: boolean;
    readonly errorMessage?: string;
  };
}

export function chatItems(line: string): readonly ChatItem[] {
  const entry = JSON.parse(line) as Entry;
  const message = entry.message;
  if (
    entry.type === "custom_message" &&
    entry.display === true &&
    typeof entry.content === "string"
  ) {
    return [{ role: "note", text: entry.content }];
  }

  if (entry.type !== "message" || !message) {
    return [];
  }

  const parts =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;

  const text = parts
    .flatMap((part) => (part.type === "text" ? (part.text ?? []) : []))
    .join("");

  switch (message.role) {
    case "user":
      return [{ role: "user", text }];
    case "assistant":
      return [
        ...(text === "" ? [] : [{ role: "assistant", text } as const]),
        ...parts.flatMap((part): ChatItem[] =>
          part.type === "toolCall"
            ? [
                {
                  role: "tool",
                  id: part.id ?? "",
                  name: part.name ?? "tool",
                  args: part.arguments,
                },
              ]
            : [],
        ),
        ...(message.errorMessage === undefined
          ? []
          : [{ role: "error", text: message.errorMessage } as const]),
      ];
    case "toolResult":
      return [
        {
          role: "result",
          id: message.toolCallId ?? "",
          name: message.toolName ?? "tool",
          text,
          failed: message.isError === true,
        },
      ];
    default:
      return [];
  }
}

const verbs: Readonly<Record<string, string>> = {
  ask_user: "Asked",
  bash: "Ran",
  edit: "Edited",
  find: "Found",
  grep: "Searched",
  ls: "Listed",
  read: "Read",
  write: "Wrote",
};

const objectKeys = ["path", "command", "pattern", "file_path", "url", "query"];

// A tool call as one line a person can scan: "Read src/app.ts", "Ran bun test".
export function describeTool(
  name: string,
  args: unknown,
): { readonly verb: string; readonly object: string } {
  const fields =
    typeof args === "object" && args !== null
      ? (args as Readonly<Record<string, unknown>>)
      : {};

  const value =
    objectKeys.map((key) => fields[key]).find((v) => typeof v === "string") ??
    Object.values(fields).find((v) => typeof v === "string");

  return {
    verb: verbs[name] ?? name,
    object: typeof value === "string" ? (value.split("\n")[0] ?? "") : "",
  };
}

export interface Step {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  readonly result?: { readonly text: string; readonly failed: boolean };
}

export type Work =
  | { readonly kind: "step"; readonly step: Step }
  | { readonly kind: "narration" | "error" | "note"; readonly text: string };

export interface Turn {
  readonly key: number;
  readonly user: string | undefined;
  readonly work: readonly Work[];
  readonly answer: readonly string[];
}

// Groups the items from one user message to the next. Text after the last
// tool call is the answer; text between tool calls narrates the work.
export function turns(
  items: readonly (ChatItem & { readonly key: number })[],
): readonly Turn[] {
  const result: { key: number; user: string | undefined; items: ChatItem[] }[] =
    [];

  for (const item of items) {
    const current = result.at(-1);
    if (item.role === "user" || !current) {
      result.push({
        key: item.key,
        user: item.role === "user" ? item.text : undefined,
        items: item.role === "user" ? [] : [item],
      });
    } else {
      current.items.push(item);
    }
  }

  return result.map(({ key, user, items: inTurn }) => {
    const lastTool = inTurn.findLastIndex(
      (item) => item.role === "tool" || item.role === "result",
    );

    const results = new Map(
      inTurn.flatMap((item) =>
        item.role === "result"
          ? [[item.id, { text: item.text, failed: item.failed }] as const]
          : [],
      ),
    );

    const work = inTurn.slice(0, lastTool + 1).flatMap((item): Work[] => {
      switch (item.role) {
        case "tool": {
          const found = results.get(item.id);

          return [
            {
              kind: "step",
              step: {
                id: item.id,
                name: item.name,
                args: item.args,
                ...(found && { result: found }),
              },
            },
          ];
        }

        case "result":
          return [];
        case "assistant":
          return [{ kind: "narration", text: item.text }];
        case "error":
        case "note":
          return [{ kind: item.role, text: item.text }];
        case "user":
          return [];
      }
    });

    const tail = inTurn.slice(lastTool + 1);

    return {
      key,
      user,
      work: [
        ...work,
        ...tail.flatMap((item): Work[] =>
          item.role === "error" || item.role === "note"
            ? [{ kind: item.role, text: item.text }]
            : [],
        ),
      ],
      answer: tail.flatMap((item) =>
        item.role === "assistant" ? [item.text] : [],
      ),
    };
  });
}
