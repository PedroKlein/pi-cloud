import type { SessionEvent } from "@pi-cloud/protocol";
import { type ComponentType, useEffect, useEffectEvent, useState } from "react";

export interface WebContext {
  // Requests go to the plugin's own routes under /api/plugins/<name>/.
  readonly request: (path: string, body?: unknown) => Promise<Response>;
  readonly openSession: (sessionId: string) => void;
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
}

export interface SessionPartProps {
  readonly context: WebContext;
  readonly session: MountedSession;
}

// Each slot is a React component rendered by the web app (ADR 0015).
export interface WebPlugin {
  readonly name: string;
  readonly nav?: {
    readonly label: string;
    readonly Page: ComponentType<PageProps>;
  };
  readonly SessionPanel?: ComponentType<SessionPartProps>;
  readonly SessionHeader?: ComponentType<SessionPartProps>;
}

// Rejects with the server's error message when the response isn't ok.
export async function json<T>(response: Promise<Response>): Promise<T> {
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

  return (await settled.json()) as T;
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
