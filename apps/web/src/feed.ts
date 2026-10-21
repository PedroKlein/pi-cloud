import type { LiveEvent, Session, SessionEvent } from "@pi-cloud/protocol";
import { command } from "./api";
import { chatItems, type ChatItem } from "./chat";
import { renderPrompt, type RenderedPrompt } from "./prompt";

type Widget = Extract<LiveEvent, { type: "widget" }>;

export interface FeedItem extends ChatItem {
  readonly key: number;
}

// What the Session view shows, rebuilt from the Session's event stream.
export interface Feed {
  readonly session: Session | undefined;
  readonly missing: boolean;
  readonly title: string | undefined;
  readonly items: readonly FeedItem[];
  readonly streaming: string | undefined;
  readonly tools: readonly { readonly id: string; readonly name: string }[];
  readonly prompts: readonly {
    readonly id: string;
    readonly element: HTMLElement;
  }[];
  readonly statuses: readonly string[];
  readonly widgetsAbove: string;
  readonly widgetsBelow: string;
  readonly queue: {
    readonly steering: readonly string[];
    readonly followUp: readonly string[];
  };
  readonly editorText: { readonly text: string } | undefined;
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
  const prompts = new Map<string, RenderedPrompt>();
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

  const shownPrompts = (): Feed["prompts"] =>
    [...prompts].map(([id, { element }]) => ({ id, element }));

  const live = (event: LiveEvent): void => {
    switch (event.type) {
      case "status":
        if (event.status === "idle") {
          update({ streaming: undefined, tools: [] });
        }

        return;
      case "text":
        update({ streaming: (feed.streaming ?? "") + event.delta });

        return;
      case "tool_start":
        update({
          tools: [
            ...feed.tools,
            { id: event.toolCallId, name: event.toolName },
          ],
        });

        return;
      case "tool_end":
        update({
          tools: feed.tools.filter(({ id }) => id !== event.toolCallId),
        });

        return;
      case "prompt": {
        const { id } = event.prompt;
        if (prompts.has(id)) {
          return;
        }

        prompts.set(
          id,
          renderPrompt(
            event.prompt,
            (value) => {
              command(sessionId, { type: "answer", id, value }).catch(report);
            },
            (questionId, value, question) => {
              command(sessionId, {
                type: "explain",
                id,
                questionId,
                value,
                question,
              }).catch(report);
            },
          ),
        );

        update({ prompts: shownPrompts() });

        return;
      }

      case "prompt_end":
        prompts.delete(event.id);
        update({ prompts: shownPrompts() });

        return;
      case "explanation":
        prompts.get(event.id)?.explained(event);

        return;
      case "notify":
        add({
          role: event.level === "error" ? "error" : "tool",
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
    prompts.clear();
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
      case "entry":
        if (event.line < lines) {
          return;
        }

        lines = event.line + 1;
        update({ streaming: undefined, tools: [] });
        add(...chatItems(event.entry));

        return;
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
