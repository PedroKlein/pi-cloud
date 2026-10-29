import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  Environment,
  EnvironmentTemplate,
  PluginInfo,
  Profile,
  Session,
} from "@pipoca/protocol";
import { responseOrder, watchChanges } from "@pipoca/plugins/web";
import { api } from "./api";
import { noticeText, settled } from "./notices";

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);

  return () => {
    window.removeEventListener("hashchange", onChange);
  };
}

export function useHash(): string {
  return useSyncExternalStore(subscribeHash, () => location.hash.slice(1));
}

interface WatchedList<T> {
  readonly value: readonly T[];
  // False until the first read comes back, while value is still empty.
  readonly loaded: boolean;
  readonly reload: () => void;
}

// Reads a JSON list from the server and reads it again whenever the server
// says its topic changed (ADR 0038).
function useWatchedList(path: string, topic: string): WatchedList<unknown> {
  const [value, setValue] = useState<readonly unknown[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [order] = useState(responseOrder);

  const reload = useCallback(() => {
    const request = order.send();

    api(path)
      .then(async (response) => {
        const list = (await response.json()) as unknown[];

        if (order.accept(request)) {
          setValue(list);
          setLoaded(true);
        }
      })
      .catch((error: unknown) => {
        // The browser session ended, so the page goes back to signing in.
        if (error instanceof Error && error.cause === "signed_out") {
          location.reload();
        }
      });
  }, [path, order]);

  useEffect(() => {
    reload();
    const unwatch = watchChanges([topic], reload);

    return () => {
      unwatch();
      order.drop();
    };
  }, [reload, order, topic]);

  return { value, loaded, reload };
}

export function useSessions(archived: boolean): WatchedList<Session> {
  return useWatchedList(
    `/api/sessions?archived=${String(archived)}&owner=all`,
    "sessions",
  ) as WatchedList<Session>;
}

export function useProfiles(): WatchedList<Profile> {
  return useWatchedList("/api/profiles", "profiles") as WatchedList<Profile>;
}

export function usePlugins(): WatchedList<PluginInfo> {
  return useWatchedList("/api/plugins", "plugins") as WatchedList<PluginInfo>;
}

export function useEnvironments(): WatchedList<Environment> {
  return useWatchedList(
    "/api/environments",
    "environments",
  ) as WatchedList<Environment>;
}

export function useTemplates(): WatchedList<EnvironmentTemplate> {
  return useWatchedList(
    "/api/templates",
    "environments",
  ) as WatchedList<EnvironmentTemplate>;
}

export interface McpToken {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export function useMcpTokens(): WatchedList<McpToken> {
  return useWatchedList(
    "/api/mcp-tokens",
    "mcp-tokens",
  ) as WatchedList<McpToken>;
}

// Tells the browser when a session stops working, unless it is on screen.
export function useSettledNotices(
  sessions: readonly Session[],
  route: string,
): void {
  const previous = useRef<readonly Session[]>([]);

  useEffect(() => {
    const done = settled(previous.current, sessions);
    previous.current = sessions;

    if (
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    ) {
      return;
    }

    for (const session of done) {
      if (session.id === route && document.visibilityState === "visible") {
        continue;
      }

      let notice: Notification;

      // Android Chrome grants permission but throws here: it only allows
      // notifications from a service worker.
      try {
        notice = new Notification(noticeText(session), { tag: session.id });
      } catch {
        return;
      }

      notice.addEventListener("click", () => {
        window.focus();
        location.hash = session.id;
        notice.close();
      });
    }
  }, [sessions, route]);
}
