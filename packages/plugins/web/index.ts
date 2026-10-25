import type {
  Environment,
  PluginSettings,
  Session,
  SessionEvent,
} from "@pi-cloud/protocol";
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

// Loads data for a component, again when key changes, on reload() and
// every everyMs when given. Stale results for an old key are dropped.
// A failed first load is thrown during render, for the error boundary the
// web app puts around every plugin part; a failed refresh keeps the last
// value.
export function useLoaded<T>(
  load: () => Promise<T>,
  key: string,
  everyMs?: number,
): { readonly value: T | undefined; readonly reload: () => void } {
  const [loaded, setLoaded] = useState<{ key: string; value: T }>();
  const [failed, setFailed] = useState<{ key: string; error: unknown }>();
  const [version, setVersion] = useState(0);
  const run = useEffectEvent(load);

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

    const timer =
      everyMs === undefined ? undefined : setInterval(fetchNow, everyMs);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [key, version, everyMs]);

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
