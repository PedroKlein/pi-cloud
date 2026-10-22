import type {
  LiveEvent,
  Prompt,
  Session,
  SessionEvent,
  SlashCommand,
} from "@pi-cloud/protocol";
import { chatItems, type ChatItem } from "./chat";

type Widget = Extract<LiveEvent, { type: "widget" }>;
export type Explanation = Extract<LiveEvent, { type: "explanation" }>;

// A question the agent is waiting on, and the explanations asked about it.
export interface OpenPrompt {
  readonly prompt: Prompt;
  readonly explanations: readonly Explanation[];
}

export type FeedItem = ChatItem & { readonly key: number };

// What the Session view shows, rebuilt from the Session's event stream.
export interface Feed {
  readonly session: Session | undefined;
  readonly missing: boolean;
  readonly title: string | undefined;
  readonly items: readonly FeedItem[];
  readonly streaming: string | undefined;
  readonly tools: readonly { readonly id: string; readonly name: string }[];
  readonly prompts: readonly OpenPrompt[];
  readonly statuses: readonly string[];
  readonly widgetsAbove: string;
  readonly widgetsBelow: string;
  readonly queue: {
    readonly steering: readonly string[];
    readonly followUp: readonly string[];
  };
  readonly editorText: { readonly text: string } | undefined;
  readonly commands: readonly SlashCommand[];
  readonly files: readonly string[];
}

export const emptyFeed: Feed = {
  session: undefined,
  missing: false,
  title: undefined,
  items: [],
  streaming: undefined,
  tools: [],
  prompts: [],
  statuses: [],
  widgetsAbove: "",
  widgetsBelow: "",
  queue: { steering: [], followUp: [] },
  editorText: undefined,
  commands: [],
  files: [],
};

export interface FollowOptions {
  readonly dispatch: (event: SessionEvent) => void;
  readonly onChange: (feed: Feed) => void;
  readonly onSession: (session: Session) => void;
}

export function follow(
  sessionId: string,
  { dispatch, onChange, onSession }: FollowOptions,
): { readonly report: (error: unknown) => void; readonly close: () => void } {
  let feed = emptyFeed;
  let lines = 0;
  let nextKey = 0;

  // Live text can arrive after the entry that already holds it; that text
  // is skipped instead of shown twice.
  let echo = "";
  const statuses = new Map<string, string>();
  const widgets = new Map<string, Widget>();

  const update = (change: Partial<Feed>): void => {
    feed = { ...feed, ...change };
    onChange(feed);
  };

  const add = (...items: readonly ChatItem[]): void => {
    update({
      items: [
        ...feed.items,
        ...items.map((item) => ({ ...item, key: nextKey++ })),
      ],
    });
  };

  const report = (error: unknown): void => {
    add({ role: "error", text: String(error) });
  };

  const surfaces = (): Partial<Feed> => {
    const widgetText = (placement: string): string =>
      [...widgets.values()]
        .filter((widget) => widget.placement === placement)
        .flatMap((widget) => widget.lines ?? [])
        .join("\n");

    return {
      statuses: [...statuses.values()],
      widgetsAbove: widgetText("aboveEditor"),
      widgetsBelow: widgetText("belowEditor"),
    };
  };

  const live = (event: LiveEvent): void => {
    switch (event.type) {
      case "status":
        echo = "";
        if (event.status === "idle") {
          update({ streaming: undefined, tools: [] });
        }

        return;
      case "text":
        if (feed.streaming === undefined && echo.startsWith(event.delta)) {
          echo = echo.slice(event.delta.length);

          return;
        }

        echo = "";
        update({ streaming: (feed.streaming ?? "") + event.delta });

        return;
      case "tool_start":
        echo = "";

        update({
          tools: [
            ...feed.tools,
            { id: event.toolCallId, name: event.toolName },
          ],
        });

        return;
      case "tool_end":
        echo = "";

        update({
          tools: feed.tools.filter(({ id }) => id !== event.toolCallId),
        });

        return;
      case "prompt":
        if (!feed.prompts.some(({ prompt }) => prompt.id === event.prompt.id)) {
          update({
            prompts: [
              ...feed.prompts,
              { prompt: event.prompt, explanations: [] },
            ],
          });
        }

        return;
      case "prompt_end":
        update({
          prompts: feed.prompts.filter(({ prompt }) => prompt.id !== event.id),
        });

        return;
      case "explanation":
        update({
          prompts: feed.prompts.map((open) =>
            open.prompt.id === event.id
              ? { ...open, explanations: [...open.explanations, event] }
              : open,
          ),
        });

        return;
      case "notify":
        add({
          role: event.level === "error" ? "error" : "note",
          text: event.message,
        });

        return;
      case "extension_status":
        if (event.text === null) {
          statuses.delete(event.key);
        } else {
          statuses.set(event.key, event.text);
        }

        update(surfaces());

        return;
      case "widget":
        if (event.lines === null) {
          widgets.delete(event.key);
        } else {
          widgets.set(event.key, event);
        }

        update(surfaces());

        return;
      case "title":
        update({ title: event.title });

        return;
      case "commands":
        update({ commands: event.commands });

        return;
      case "files":
        update({ files: event.paths });

        return;
      case "editor_text":
        update({ editorText: { text: event.text } });

        return;
      case "plugin":
        return;
      case "queue":
        update({
          queue: { steering: event.steering, followUp: event.followUp },
        });

        return;
    }
  };

  const events = new EventSource(
    `/api/sessions/${encodeURIComponent(sessionId)}/events`,
  );

  events.addEventListener("error", () => {
    if (events.readyState === EventSource.CLOSED) {
      update({ missing: true });
    }
  });

  events.addEventListener("open", () => {
    statuses.clear();
    widgets.clear();
    update({ ...surfaces(), prompts: [], queue: emptyFeed.queue });
  });

  events.addEventListener("message", (message: MessageEvent<string>) => {
    const event = JSON.parse(message.data) as SessionEvent;
    dispatch(event);
    switch (event.type) {
      case "session":
        update({ session: event.session });
        onSession(event.session);

        return;
      case "entry": {
        if (event.line < lines) {
          return;
        }

        lines = event.line + 1;
        const items = chatItems(event.entry);

        echo = items
          .flatMap((item) => (item.role === "assistant" ? [item.text] : []))
          .join("");

        update({ streaming: undefined, tools: [] });
        add(...items);

        return;
      }

      case "live":
        live(event.event);

        return;
    }
  });

  return {
    report,
    close: () => {
      events.close();
    },
  };
}
