import { changes } from "@pi-cloud/changes/web";
import { kubernetes } from "@pi-cloud/kubernetes/web";
import { library } from "@pi-cloud/library/web";
import { models } from "@pi-cloud/models/web";
import type {
  NavItemsProps,
  ToolCallProps,
  WebContext,
  WebPlugin,
  WidgetProps,
} from "@pi-cloud/plugins/web";
import type { PluginInfo, PluginSettings, Session } from "@pi-cloud/protocol";
import { projects } from "@pi-cloud/projects/web";
import { subagents } from "@pi-cloud/subagents/web";
import { usage } from "@pi-cloud/usage/web";
import type { ComponentType } from "react";
import { EmbeddedSession } from "./embedded-session";

// The web parts of the plugins built into this bundle (ADR 0015).
const webPlugins: readonly WebPlugin[] = [
  usage,
  changes,
  projects,
  library,
  models,
  subagents,
  kubernetes,
];

let enabled: readonly WebPlugin[] = [];
let settings: ReadonlyMap<string, PluginSettings> = new Map();

export async function loadPlugins(): Promise<void> {
  const response = await fetch("/api/plugins");
  const listed = (await response.json()) as PluginInfo[];
  const on = listed.filter(({ state }) => state === "on");

  enabled = webPlugins.filter(({ name }) => on.some(({ id }) => id === name));
  settings = new Map(on.map(({ id, values }) => [id, values]));
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
    settings: settings.get(name) ?? {},
    SessionView: EmbeddedSession,
  };

  contexts.set(name, context);

  return context;
}

export interface Claimed<Props> {
  readonly plugin: string;
  readonly Component: ComponentType<Props>;
}

// The enabled plugin that draws calls of a tool, if any (ADR 0030).
export function toolRenderer(name: string): Claimed<ToolCallProps> | undefined {
  return claimed(name, ({ tools }) => tools);
}

// The enabled plugin that draws an extension widget, if any (ADR 0030).
export function widgetRenderer(key: string): Claimed<WidgetProps> | undefined {
  return claimed(key, ({ widgets }) => widgets);
}

function claimed<Props>(
  key: string,
  slots: (
    plugin: WebPlugin,
  ) => Readonly<Record<string, ComponentType<Props>>> | undefined,
): Claimed<Props> | undefined {
  for (const plugin of enabled) {
    const Component = slots(plugin)?.[key];

    if (Component) {
      return { plugin: plugin.name, Component };
    }
  }

  return undefined;
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

// A Session a plugin owns opens in that plugin's page (ADR 0028).
export function sessionHref(session: Session): string {
  const plugin = enabled.find(({ name }) => name === session.owner?.plugin);
  const path = plugin?.sessionPath?.(session);

  return plugin && path !== undefined
    ? `#plugin/${plugin.name}/${path}`
    : `#${session.id}`;
}

export function pageFills(name: string, path: string): boolean {
  return (
    enabled.find((plugin) => plugin.name === name)?.nav?.fills?.(path) === true
  );
}
