import { changes } from "@pipoca/changes/web";
import { kubernetes } from "@pipoca/kubernetes/web";
import { library } from "@pipoca/library/web";
import { meta } from "@pipoca/meta/web";
import { models } from "@pipoca/models/web";
import { oidc } from "@pipoca/oidc/web";
import type {
  NavItemsProps,
  ToolCallProps,
  WebContext,
  WebPlugin,
  WidgetProps,
} from "@pipoca/plugins/web";
import type { PluginInfo, PluginSettings, Session } from "@pipoca/protocol";
import { projects } from "@pipoca/projects/web";
import { subagents } from "@pipoca/subagents/web";
import { usage } from "@pipoca/usage/web";
import * as plugins from "@pipoca/plugins/web";
import * as ui from "@pipoca/ui";
import * as react from "react";
import type { ComponentType } from "react";
import * as reactDom from "react-dom";
import * as reactDomClient from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import { EmbeddedSession } from "./embedded-session";

// The web parts of the plugins built into this bundle (ADR 0015).
const webPlugins: readonly WebPlugin[] = [
  meta,
  usage,
  changes,
  projects,
  library,
  models,
  subagents,
  kubernetes,
  oidc,
];

let enabled: readonly WebPlugin[] = [];
const webErrors = new Map<string, string>();
let settings: ReadonlyMap<string, PluginSettings> = new Map();
let titles: ReadonlyMap<string, string> = new Map();

// An installed plugin's web part is bundled with these left out, and reads
// them from here, so the page has one React and one design system (ADR 0022).
Object.assign(globalThis, {
  pipocaShared: {
    react,
    "react/jsx-runtime": jsxRuntime,
    "react-dom": reactDom,
    "react-dom/client": reactDomClient,
    "@pipoca/ui": ui,
    "@pipoca/plugins/web": plugins,
  },
});

export async function loadPlugins(): Promise<void> {
  const response = await fetch("/api/plugins");
  const listed = (await response.json()) as PluginInfo[];
  const on = listed.filter(({ state }) => state === "on");

  const installed = await Promise.all(
    on.flatMap(({ id, webPart }) =>
      webPart === undefined ? [] : [importWebPart(id, webPart)],
    ),
  );

  enabled = [
    ...webPlugins.filter(({ name }) => on.some(({ id }) => id === name)),
    ...installed.flatMap((plugin) => (plugin ? [plugin] : [])),
  ];

  settings = new Map(on.map(({ id, values }) => [id, values]));
  titles = new Map(on.map(({ id, title }) => [id, title]));
}

async function importWebPart(
  id: string,
  url: string,
): Promise<WebPlugin | undefined> {
  try {
    // The page waits for every web part before it draws, so one that never
    // finishes loading can't keep it blank.
    const { default: plugin } = (await Promise.race([
      import(url),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("it took longer than 10 seconds to load"));
        }, 10_000);
      }),
    ])) as { default?: WebPlugin };

    if (plugin?.name !== id) {
      throw new Error(`its default export must be a web part named ${id}`);
    }

    if (
      plugin.nav !== undefined &&
      (typeof plugin.nav.label !== "string" ||
        typeof plugin.nav.Page !== "function")
    ) {
      throw new Error("its nav needs a label and a Page component");
    }

    return plugin;
  } catch (error) {
    webErrors.set(id, error instanceof Error ? error.message : String(error));

    return undefined;
  }
}

// Why an installed plugin's web part didn't load in this page.
export function webPartError(id: string): string | undefined {
  return webErrors.get(id);
}

export function pluginTitle(name: string): string {
  return titles.get(name) ?? name;
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
  const path = guarded(() => plugin?.sessionPath?.(session));

  return plugin && path !== undefined
    ? `#plugin/${plugin.name}/${path}`
    : `#${session.id}`;
}

export function pageFills(name: string, path: string): boolean {
  return (
    guarded(() =>
      enabled.find((plugin) => plugin.name === name)?.nav?.fills?.(path),
    ) === true
  );
}

// A plugin's function the shell calls while it draws, outside any plugin's
// error boundary, so a throw counts as no answer instead of breaking the app.
function guarded<T>(call: () => T): T | undefined {
  try {
    return call();
  } catch {
    return undefined;
  }
}
