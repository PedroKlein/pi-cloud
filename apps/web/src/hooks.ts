import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Environment, Session } from "@pi-cloud/protocol";
import { api } from "./api";
import { noticeText, settled } from "./notices";
import { responseOrder } from "./responses";

const refreshMs = 2000;

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);

  return () => {
    window.removeEventListener("hashchange", onChange);
  };
}

export function useHash(): string {
  return useSyncExternalStore(subscribeHash, () => location.hash.slice(1));
}

interface Polled<T> {
  readonly value: readonly T[];
  readonly reload: () => void;
}

// Reads a JSON list from the server and keeps it fresh while mounted.
function usePolled(path: string): Polled<unknown> {
  const [value, setValue] = useState<readonly unknown[]>([]);
  const [order] = useState(responseOrder);

  const reload = useCallback(() => {
    const request = order.send();

    api(path)
      .then(async (response) => {
        const list = (await response.json()) as unknown[];

        if (order.accept(request)) {
          setValue(list);
        }
      })
      .catch(() => undefined);
  }, [path, order]);

  useEffect(() => {
    reload();
    const timer = setInterval(reload, refreshMs);

    return () => {
      clearInterval(timer);
      order.drop();
    };
  }, [reload, order]);

  return { value, reload };
}

export function useSessions(archived: boolean): Polled<Session> {
  return usePolled(
    `/api/sessions?archived=${String(archived)}&owner=all`,
  ) as Polled<Session>;
}

export function useEnvironments(): Polled<Environment> {
  return usePolled("/api/environments") as Polled<Environment>;
}

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
