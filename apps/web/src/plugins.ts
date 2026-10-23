import { changes } from "@pi-cloud/changes/web";
import { library } from "@pi-cloud/library/web";
import { models } from "@pi-cloud/models/web";
import type {
  NavItemsProps,
  WebContext,
  WebPlugin,
} from "@pi-cloud/plugins/web";
import { projects } from "@pi-cloud/projects/web";
import { usage } from "@pi-cloud/usage/web";
import type { ComponentType } from "react";

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
    href: (path) => `#plugin/${name}/${path}`,
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
