import { changes } from "@pi-cloud/changes/web";
import { library } from "@pi-cloud/library/web";
import { models } from "@pi-cloud/models/web";
import type {
  MountedSession,
  NavItemsProps,
  WebContext,
  WebPlugin,
} from "@pi-cloud/plugins/web";
import { projects } from "@pi-cloud/projects/web";
import type { SessionEvent } from "@pi-cloud/protocol";
import { usage } from "@pi-cloud/usage/web";
import type { ComponentType } from "react";
import { command } from "./api";

// The web parts of the plugins built into this bundle (ADR 0015).
const webPlugins: readonly WebPlugin[] = [
  usage,
  changes,
  projects,
  library,
  models,
];

let enabled: readonly WebPlugin[] = [];

export async function loadPlugins(): Promise<void> {
  const response = await fetch("/api/plugins");
  const names = (await response.json()) as string[];
  enabled = webPlugins.filter(({ name }) => names.includes(name));
}

export function enabledPlugins(): readonly WebPlugin[] {
  return enabled;
}

const contexts = new Map<string, WebContext>();

export function pluginContext(name: string): WebContext {
  const cached = contexts.get(name);
  if (cached) {
    return cached;
  }

  const context: WebContext = {
    request: async (path, body) =>
      fetch(`/api/plugins/${name}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body !== undefined && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      }),
    openSession: (sessionId) => {
      location.hash = sessionId;
    },
    href: (path) => `#plugin/${name}/${path}`,
  };

  contexts.set(name, context);

  return context;
}

// The Session view hands every event it receives to dispatch, so plugins
// share its stream instead of opening their own.
export function sessionChannel(id: string): {
  readonly session: MountedSession;
  readonly dispatch: (event: SessionEvent) => void;
} {
  const listeners = new Set<(event: SessionEvent) => void>();

  return {
    session: {
      id,
      events: (listener) => {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
      send: async (text) =>
        command(id, {
          type: "message",
          text,
          requestId: crypto.randomUUID(),
          delivery: "steer",
        }),
    },
    dispatch: (event) => {
      listeners.forEach((listener) => {
        listener(event);
      });
    },
  };
}

export interface NavEntry {
  readonly name: string;
  readonly label: string;
  readonly Items?: ComponentType<NavItemsProps>;
}

export function navEntries(): readonly NavEntry[] {
  return enabled.flatMap(({ name, nav }) =>
    nav
      ? [{ name, label: nav.label, ...(nav.Items && { Items: nav.Items }) }]
      : [],
  );
}

// "plugin/projects/p1" is the projects page open at "p1".
export function pluginRoute(
  route: string,
): { readonly name: string; readonly path: string } | undefined {
  const match = /^plugin\/([^/]+)\/?(.*)$/.exec(route);

  return match ? { name: match[1] ?? "", path: match[2] ?? "" } : undefined;
}
