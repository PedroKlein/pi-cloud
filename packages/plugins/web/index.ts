import type {
  Environment,
  PluginSettings,
  Session,
  SessionEvent,
} from "@pipoca/protocol";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useState,
} from "react";

// The shell's own Session view, for a plugin page to show a Session in
// (ADR 0028). A side view is a narrow panel next to the page's main view.
export interface EmbeddedSessionProps {
  readonly sessionId: string;
  readonly layout: "full" | "side";
  // Replaces the Session's own title in the header.
  readonly title?: string;
  // Shown before the title, such as a link back to the page.
  readonly crumb?: ReactNode;
  // Buttons at the end of the header.
  readonly actions?: ReactNode;
}

export interface WebContext {
  // Requests go to the plugin's own routes under /api/plugins/<name>/.
  readonly request: (path: string, body?: unknown) => Promise<Response>;
  readonly openSession: (sessionId: string) => void;
  // The link to a path inside the plugin's own page.
  readonly href: (path: string) => string;
  // The plugin's settings when the page loaded (ADR 0036).
  readonly settings: PluginSettings;
  readonly SessionView: ComponentType<EmbeddedSessionProps>;
}

export interface MountedSession {
  readonly id: string;
  // Every event the Session view receives, from the start of its stream.
  readonly events: (listener: (event: SessionEvent) => void) => () => void;
  // Sends a message as the user, such as one of the plugin's Pi commands.
  readonly send: (text: string) => Promise<void>;
}

export interface PageProps {
  readonly context: WebContext;
  // The rest of the address after the plugin's page, "" on the page itself.
  readonly path: string;
}

// The home screen, at the root of the app (ADR 0035).
export interface HomeProps {
  readonly context: WebContext;
  readonly onNewSession: () => void;
}

export interface NavItemsProps {
  readonly context: WebContext;
  // The open path inside the plugin's page, undefined when it isn't open.
  readonly path: string | undefined;
}

// A notice the plugin sent a Session, drawn in its chat (ADR 0028).
export interface NoticeProps {
  readonly context: WebContext;
  readonly text: string;
  readonly data: unknown;
}

// A link of the plugin's own scheme in a chat answer, as [label](scheme:target).
export interface LinkProps {
  readonly context: WebContext;
  readonly target: string;
  readonly label: string;
}

export interface SessionPartProps {
  readonly context: WebContext;
  readonly session: MountedSession;
}

export interface EnvironmentSectionProps {
  readonly context: WebContext;
  readonly environment: Environment;
}

// A tool call a plugin draws in the chat, from the transcript (ADR 0030).
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  readonly status: "running" | "done" | "failed";
  readonly result?: {
    readonly text: string;
    readonly details: unknown;
    readonly failed: boolean;
  };
}

export interface ToolCallProps extends SessionPartProps {
  readonly call: ToolCall;
}

export interface WidgetProps extends SessionPartProps {
  // The widget's lines as Pi's TUI renders them, with SGR escape codes.
  readonly lines: readonly string[];
}

// Each slot is a React component rendered by the web app (ADR 0015).
export interface WebPlugin {
  readonly name: string;
  readonly nav?: {
    readonly label: string;
    readonly Page: ComponentType<PageProps>;
    // Links listed under the entry in the sidebar, such as each Project.
    readonly Items?: ComponentType<NavItemsProps>;
    // Paths whose page fills the window, such as an open Project, instead of
    // scrolling in the shell's column.
    readonly fills?: (path: string) => boolean;
  };
  // The first enabled plugin with a home screen draws the app's root.
  readonly Home?: ComponentType<HomeProps>;
  // Where a Session this plugin owns opens, as a path in its page. Links,
  // search results and notices for it go there (ADR 0028).
  readonly sessionPath?: (session: Session) => string;
  // Renderers for the plugin's notices in a chat, by kind.
  readonly notices?: Readonly<Record<string, ComponentType<NoticeProps>>>;
  // Renderers for links in chat answers, by URL scheme.
  readonly links?: Readonly<Record<string, ComponentType<LinkProps>>>;
  readonly SessionPanel?: ComponentType<SessionPartProps>;
  // A section on the Environments page for the open Environment, such as the
  // plugin's settings for it (ADR 0032).
  readonly EnvironmentSection?: ComponentType<EnvironmentSectionProps>;
  // A section on the user's Settings page, such as their linked accounts.
  readonly SettingsSection?: ComponentType<{ readonly context: WebContext }>;
  readonly SessionHeader?: ComponentType<SessionPartProps>;
  // Tools whose calls the plugin draws instead of a work step, by name.
  readonly tools?: Readonly<Record<string, ComponentType<ToolCallProps>>>;
  // Extension widgets the plugin draws in their place, by widget key.
  readonly widgets?: Readonly<Record<string, ComponentType<WidgetProps>>>;
}

// Rejects with the server's error message when the response isn't ok.
export async function json<T>(response: Promise<Response>): Promise<T> {
  return (await (await ok(response)).json()) as T;
}

// Like json, for responses without a body.
export async function ok(response: Promise<Response>): Promise<Response> {
  const settled = await response;

  if (!settled.ok) {
    const body = (await settled.json().catch(() => ({}))) as {
      error?: unknown;
    };

    throw new Error(
      typeof body.error === "string"
        ? body.error
        : `${String(settled.status)} ${settled.statusText}`,
    );
  }

  return settled;
}

interface Watcher {
  readonly topics: readonly string[];
  readonly onChange: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

// The part of a browser EventSource that watchChanges uses.
interface ChangeStream {
  readonly readyState: number;
  addEventListener(
    type: "open" | "error" | "message",
    listener: (event: { readonly data: string }) => void,
  ): void;
  close(): void;
}

const closedState = 2;

// A burst of changes, such as a turn starting and its title arriving,
// becomes one fetch.
const settleMs = 250;

const watchers = new Set<Watcher>();
let stream: ChangeStream | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let failures = 0;

function notify(watcher: Watcher): void {
  clearTimeout(watcher.timer);
  watcher.timer = setTimeout(watcher.onChange, settleMs);
}

// A browser reconnects by itself after the connection drops, but not after
// an error response, such as while the server restarts.
function connect(): void {
  const { EventSource } = globalThis as unknown as {
    EventSource: new (url: string) => ChangeStream;
  };

  const source = new EventSource("/api/changes");
  let lost = false;
  stream = source;

  source.addEventListener("message", (event) => {
    const { topic } = JSON.parse(event.data) as { topic: string };

    for (const watcher of watchers) {
      if (watcher.topics.includes(topic)) {
        notify(watcher);
      }
    }
  });

  source.addEventListener("error", () => {
    lost = true;

    if (source.readyState === closedState && stream === source) {
      retry = setTimeout(connect, Math.min(1000 * 2 ** failures, 30_000));
      failures++;
    }
  });

  source.addEventListener("open", () => {
    failures = 0;

    if (lost) {
      lost = false;
      watchers.forEach(notify);
    }
  });
}

// Calls onChange when the server says one of the topics changed, and after
// the page reconnects, since changes sent while it was away are not resent
// (ADR 0038). One stream serves the whole page.
export function watchChanges(
  topics: readonly string[],
  onChange: () => void,
): () => void {
  const watcher: Watcher = { topics, onChange };
  watchers.add(watcher);

  if (stream === undefined) {
    connect();
  }

  return () => {
    clearTimeout(watcher.timer);
    watchers.delete(watcher);

    if (watchers.size === 0) {
      clearTimeout(retry);
      stream?.close();
      stream = undefined;
      failures = 0;
    }
  };
}

// Loads data for a component, again when key changes, on reload(), when one
// of the topics changes, and every everyMs for data that changes outside
// Pipoca. Stale results for an old key are dropped.
// A failed first load is thrown during render, for the error boundary the
// web app puts around every plugin part; a failed refresh keeps the last
// value.
export function useLoaded<T>(
  load: () => Promise<T>,
  key: string,
  {
    topics = [],
    everyMs,
  }: { readonly topics?: readonly string[]; readonly everyMs?: number } = {},
): { readonly value: T | undefined; readonly reload: () => void } {
  const [loaded, setLoaded] = useState<{ key: string; value: T }>();
  const [failed, setFailed] = useState<{ key: string; error: unknown }>();
  const [version, setVersion] = useState(0);
  const run = useEffectEvent(load);
  // A string, so a new array with the same topics doesn't fetch again.
  const watched = topics.join(" ");

  useEffect(() => {
    let live = true;

    const fetchNow = (): void => {
      run().then(
        (value) => {
          if (live) {
            setLoaded({ key, value });
          }
        },
        (error: unknown) => {
          if (live) {
            setFailed({ key, error });
          }
        },
      );
    };

    fetchNow();

    const unwatch =
      watched === "" ? undefined : watchChanges(watched.split(" "), fetchNow);

    const timer =
      everyMs === undefined ? undefined : setInterval(fetchNow, everyMs);

    return () => {
      live = false;
      unwatch?.();
      clearInterval(timer);
    };
  }, [key, version, watched, everyMs]);

  const value = loaded?.key === key ? loaded.value : undefined;

  if (value === undefined && failed?.key === key) {
    throw failed.error;
  }

  return {
    value,
    reload: () => {
      setVersion((current) => current + 1);
    },
  };
}

// The current time, again every everyMs, for "5m ago" labels.
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, everyMs);

    return () => {
      clearInterval(timer);
    };
  }, [everyMs]);

  return now;
}
