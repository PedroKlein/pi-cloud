import type { Unmount, WebContext, WebPlugin } from "@pi-cloud/plugins/web";

// The web parts of the plugins built into this bundle (ADR 0015).
const webPlugins: readonly WebPlugin[] = [];

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

export function mountSession(
  sessionId: string,
  header: HTMLElement,
  panels: HTMLElement,
): Unmount {
  const unmounts = enabled.flatMap(({ name, sessionHeader, sessionPanel }) => [
    ...(sessionHeader
      ? [sessionHeader(slot(header, name), context(name), sessionId)]
      : []),
    ...(sessionPanel
      ? [sessionPanel(slot(panels, name), context(name), sessionId)]
      : []),
  ]);

  return () => {
    unmounts.forEach((unmount) => {
      unmount();
    });

    header.replaceChildren();
    panels.replaceChildren();
  };
}

export function renderNav(nav: HTMLElement): void {
  nav.replaceChildren(
    ...enabled.flatMap(({ name, nav: entry }) => {
      if (!entry) {
        return [];
      }

      const link = document.createElement("a");
      link.href = `#plugin/${name}`;
      link.textContent = entry.label;

      return [link];
    }),
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
