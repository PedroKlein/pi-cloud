import { type ImageAttachment, imageTypes } from "@pi-cloud/protocol";

export type ChatItem = (
  | {
      readonly role: "user";
      readonly text: string;
      readonly images?: readonly ImageAttachment[];
    }
  | {
      readonly role: "assistant";
      readonly text: string;
      readonly model?: string;
    }
  | {
      readonly role: "error" | "note";
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
    }
) & { readonly at?: string };

interface Part {
  readonly type: string;
  readonly text?: string;
  readonly mimeType?: string;
  readonly data?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: unknown;
}

interface Entry {
  readonly type: string;
  readonly id?: string;
  readonly timestamp?: string;
  readonly content?: unknown;
  readonly display?: boolean;
  readonly message?: {
    readonly role: string;
    readonly content?: string | readonly Part[];
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly isError?: boolean;
    readonly errorMessage?: string;
    readonly model?: string;
    readonly command?: string;
    readonly output?: string;
    readonly exitCode?: number | null;
    readonly cancelled?: boolean;
  };
}

// Extensions color the text they post for Pi's TUI: CSI sequences such as
// colors, and OSC sequences such as links.
const terminalCodes =
  // eslint-disable-next-line no-control-regex -- escape codes are what it matches
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function chatItems(line: string): readonly ChatItem[] {
  let entry: Entry;

  try {
    entry = JSON.parse(line) as Entry;
  } catch {
    return [];
  }

  const at = entry.timestamp;

  return entryItems(entry).map((item) =>
    at === undefined ? item : { ...item, at },
  );
}

function entryItems(entry: Entry): readonly ChatItem[] {
  const message = entry.message;
  if (
    entry.type === "custom_message" &&
    entry.display === true &&
    typeof entry.content === "string"
  ) {
    return [{ role: "note", text: entry.content.replace(terminalCodes, "") }];
  }

  if (entry.type !== "message" || !message) {
    return [];
  }

  const parts =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : (message.content ?? []);

  const text = parts
    .flatMap((part) => (part.type === "text" ? (part.text ?? []) : []))
    .join("");

  switch (message.role) {
    case "user": {
      const images = parts.flatMap((part): ImageAttachment[] => {
        const mimeType = imageTypes.find((known) => known === part.mimeType);

        return part.type === "image" &&
          mimeType !== undefined &&
          part.data !== undefined
          ? [{ mimeType, data: part.data }]
          : [];
      });

      return [{ role: "user", text, ...(images.length > 0 && { images }) }];
    }

    case "assistant":
      return [
        ...(text === ""
          ? []
          : [
              {
                role: "assistant",
                text,
                ...(message.model !== undefined && { model: message.model }),
              } as const,
            ]),
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
    // A command the user ran in Pi with "!".
    case "bashExecution": {
      const id = entry.id ?? "";
      const command = message.command ?? "";

      return [
        { role: "tool", id, name: "bash", args: { command } },
        {
          role: "result",
          id,
          name: "bash",
          text: message.output ?? "",
          failed: message.cancelled === true || (message.exitCode ?? 0) !== 0,
        },
      ];
    }

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
  readonly images?: readonly ImageAttachment[];
  readonly work: readonly Work[];
  readonly answer: readonly string[];
  readonly started?: string;
  readonly ended?: string;
  readonly model?: string;
}

// Groups the items from one user message to the next. Text after the last
// tool call is the answer; text between tool calls narrates the work.
export function turns(
  items: readonly (ChatItem & { readonly key: number })[],
): readonly Turn[] {
  const result: {
    key: number;
    user: string | undefined;
    images: readonly ImageAttachment[] | undefined;
    started: string | undefined;
    items: ChatItem[];
  }[] = [];

  for (const item of items) {
    const current = result.at(-1);
    if (item.role === "user" || !current) {
      result.push({
        key: item.key,
        user: item.role === "user" ? item.text : undefined,
        images: item.role === "user" ? item.images : undefined,
        started: item.at,
        items: item.role === "user" ? [] : [item],
      });
    } else {
      current.items.push(item);
    }
  }

  return result.map(({ key, user, images, started, items: inTurn }) => {
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

    const ended = inTurn.findLast(
      (item) => item.role !== "note" && item.at !== undefined,
    )?.at;

    const model = inTurn.findLast(
      (item) => item.role === "assistant" && item.model !== undefined,
    );

    return {
      key,
      user,
      ...(images && { images }),
      ...(started !== undefined && { started }),
      ...(ended !== undefined && { ended }),
      ...(model?.role === "assistant" &&
        model.model !== undefined && { model: model.model }),
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

const tallies: readonly {
  readonly tools: readonly string[];
  readonly label: (count: number) => string;
}[] = [
  { tools: ["read"], label: (n) => `read ${counted(n, "file")}` },
  { tools: ["edit", "write"], label: (n) => `edited ${counted(n, "file")}` },
  { tools: ["bash"], label: (n) => `ran ${counted(n, "command")}` },
];

// What a turn's work did, as in "read 6 files · ran 1 command".
export function tally(steps: readonly { readonly name: string }[]): string[] {
  const known = new Set(tallies.flatMap(({ tools }) => tools));
  const others = steps.filter(({ name }) => !known.has(name)).length;

  return [
    ...tallies.flatMap(({ tools, label }) => {
      const count = steps.filter(({ name }) => tools.includes(name)).length;

      return count === 0 ? [] : [label(count)];
    }),
    ...(others === 0 ? [] : [counted(others, "other step")]),
  ];
}

function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

export function duration(from: string, to: string): string {
  const seconds = Math.max(
    0,
    Math.round((Date.parse(to) - Date.parse(from)) / 1000),
  );

  const minutes = Math.floor(seconds / 60);

  return minutes === 0
    ? `${String(seconds)}s`
    : `${String(minutes)}m ${String(seconds % 60)}s`;
}

export function ago(at: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);

  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${String(minutes)} min ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${String(hours)} h ago`;
  }

  return new Date(at).toLocaleDateString();
}

// Login notes carry the URLs to open (ADR 0024). A URL doesn't end with the
// sentence's punctuation.
export function linkParts(
  text: string,
): { readonly text: string; readonly link: boolean }[] {
  return text
    .split(/(https?:\/\/\S*[^\s.,;:!?)])/)
    .map((part, at) => ({ text: part, link: at % 2 === 1 }))
    .filter((part) => part.text !== "");
}
