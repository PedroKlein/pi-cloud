export interface ChatItem {
  readonly role: "user" | "assistant" | "tool" | "error";
  readonly text: string;
}

interface Part {
  readonly type: string;
  readonly text?: string;
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
    return [{ role: "tool", text: entry.content }];
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
                  text: `${part.name ?? "tool"} ${JSON.stringify(part.arguments)}`,
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
          role: message.isError === true ? "error" : "tool",
          text: `${message.toolName ?? "tool"} → ${text}`,
        },
      ];
    default:
      return [];
  }
}
