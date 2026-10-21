import { changes } from "@pi-cloud/changes/web";
import { library } from "@pi-cloud/library/web";
import { models } from "@pi-cloud/models/web";
import type {
  MountedSession,
  WebContext,
  WebPlugin,
} from "@pi-cloud/plugins/web";
import { projects } from "@pi-cloud/projects/web";
import type { SessionEvent } from "@pi-cloud/protocol";
import { usage } from "@pi-cloud/usage/web";

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

export function pluginContext(name: string): WebContext {
  return {
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
  };
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
}

export function navEntries(): readonly NavEntry[] {
  return enabled.flatMap(({ name, nav }) =>
    nav ? [{ name, label: nav.label }] : [],
  );
}
