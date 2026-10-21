import { changes } from "@pi-cloud/changes/web";
import { library } from "@pi-cloud/library/web";
import { models } from "@pi-cloud/models/web";
import type { Unmount, WebContext, WebPlugin } from "@pi-cloud/plugins/web";
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

function context(name: string): WebContext {
  return {
    request: async (path, body) =>
      fetch(`/api/plugins/${name}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body !== undefined && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      }),
    sessionEvents: (sessionId, listener) => {
      const events = new EventSource(
        `/api/sessions/${encodeURIComponent(sessionId)}/events`,
      );

      events.addEventListener("message", (message: MessageEvent<string>) => {
        listener(JSON.parse(message.data) as Parameters<typeof listener>[0]);
      });

      return () => {
        events.close();
      };
    },
    openSession: (sessionId) => {
      location.hash = sessionId;
    },
  };
}

// Each plugin renders into its own element, so one can't clear another's.
function slot(parent: HTMLElement, name: string): HTMLElement {
  const element = document.createElement("div");
  element.dataset["plugin"] = name;
  parent.append(element);

  return element;
}

// The Session view hands every event it receives to dispatch, so plugins
// share its stream instead of opening their own.
export function mountSession(
  sessionId: string,
  header: HTMLElement,
  panels: HTMLElement,
): {
  readonly dispatch: (event: SessionEvent) => void;
  readonly unmount: Unmount;
} {
  const listeners = new Set<(event: SessionEvent) => void>();

  const session = {
    id: sessionId,
    events: (listener: (event: SessionEvent) => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };

  const unmounts = enabled.flatMap(({ name, sessionHeader, sessionPanel }) => [
    ...(sessionHeader
      ? [sessionHeader(slot(header, name), context(name), session)]
      : []),
    ...(sessionPanel
      ? [sessionPanel(slot(panels, name), context(name), session)]
      : []),
  ]);

  return {
    dispatch: (event) => {
      listeners.forEach((listener) => {
        listener(event);
      });
    },
    unmount: () => {
      unmounts.forEach((unmount) => {
        unmount();
      });

      listeners.clear();
      header.replaceChildren();
      panels.replaceChildren();
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

export function mountPage(name: string, page: HTMLElement): Unmount {
  const plugin = enabled.find((candidate) => candidate.name === name);
  const unmount = plugin?.nav?.mount(slot(page, name), context(name));

  return () => {
    unmount?.();
    page.replaceChildren();
  };
}
