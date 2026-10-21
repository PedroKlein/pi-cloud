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

export async function json<T>(response: Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

// Loads data for a component, again when key changes, on reload() and
// every everyMs when given. Stale results for an old key are dropped.
export function useLoaded<T>(
  load: () => Promise<T>,
  key: string,
  everyMs?: number,
): { readonly value: T | undefined; readonly reload: () => void } {
  const [loaded, setLoaded] = useState<{ key: string; value: T }>();
  const [version, setVersion] = useState(0);
  const run = useEffectEvent(load);

  useEffect(() => {
    let live = true;

    const fetchNow = (): void => {
      void run().then((value) => {
        if (live) {
          setLoaded({ key, value });
        }
      });
    };

    fetchNow();

    const timer =
      everyMs === undefined ? undefined : setInterval(fetchNow, everyMs);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [key, version, everyMs]);

  return {
    value: loaded?.key === key ? loaded.value : undefined,
    reload: () => {
      setVersion((current) => current + 1);
    },
  };
}
