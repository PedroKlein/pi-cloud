import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Environment, Session } from "@pi-cloud/protocol";
import { api } from "./api";

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

  const reload = useCallback(() => {
    api(path)
      .then(async (response) => {
        setValue((await response.json()) as unknown[]);
      })
      .catch(() => undefined);
  }, [path]);

  useEffect(() => {
    reload();
    const timer = setInterval(reload, refreshMs);

    return () => {
      clearInterval(timer);
    };
  }, [reload]);

  return { value, reload };
}

export function useSessions(archived: boolean): Polled<Session> {
  return usePolled(
    `/api/sessions?archived=${String(archived)}`,
  ) as Polled<Session>;
}

export function useEnvironments(): Polled<Environment> {
  return usePolled("/api/environments") as Polled<Environment>;
}
