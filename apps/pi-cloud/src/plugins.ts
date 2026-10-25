import { basename } from "node:path";
import askPackage from "@pi-cloud/ask/package.json";
import { ask } from "@pi-cloud/ask/session";
import changesPackage from "@pi-cloud/changes/package.json";
import { changes } from "@pi-cloud/changes/session";
import kubernetesPackage from "@pi-cloud/kubernetes/package.json";
import { kubernetesPlugin } from "@pi-cloud/kubernetes/server";
import libraryPackage from "@pi-cloud/library/package.json";
import { library } from "@pi-cloud/library/server";
import { library as librarySession } from "@pi-cloud/library/session";
import metaPackage from "@pi-cloud/meta/package.json";
import { meta } from "@pi-cloud/meta/server";
import { metaSession } from "@pi-cloud/meta/session";
import modelsPackage from "@pi-cloud/models/package.json";
import { models } from "@pi-cloud/models/server";
import { models as modelsSession } from "@pi-cloud/models/session";
import projectsPackage from "@pi-cloud/projects/package.json";
import { projects } from "@pi-cloud/projects/server";
import subagentsPackage from "@pi-cloud/subagents/package.json";
import { subagents } from "@pi-cloud/subagents/session";
import usagePackage from "@pi-cloud/usage/package.json";
import {
  checkedSettings,
  type EventBus,
  type ModelOffer,
  type OfferedModels,
  type PluginRoute,
  type PluginStore,
  type RouteTool,
  type ServerPlugin,
  type ServerPluginContext,
  type ServerTool,
  type SessionPlugin,
  settingValues,
  type ToolCaller,
  type Toolset,
} from "@pi-cloud/plugins";
import {
  type Actor,
  type Assignment,
  type Capability,
  capabilities,
  type Command,
  type PluginInfo,
  type PluginManifest,
  type PluginSettings,
  type Session,
  type ToolCall,
  type ToolNamespace,
  type ToolResult,
  type ToolSpec,
  type UiAction,
} from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";
import {
  owner,
  type PluginProfile,
  type Result,
  type SessionPlugins,
  type Sessions,
} from "@pi-cloud/sessions";
import type { PluginSettingsStore } from "./store";

// The plugins built into this binary (ADR 0015), described by the piCloud
// field of their package.json (ADR 0036). Each app imports its own parts
// statically, so the compiled binary needs no dynamic loading.
export const builtInPlugins: readonly PluginManifest[] = [
  askPackage,
  changesPackage,
  usagePackage,
  projectsPackage,
  libraryPackage,
  modelsPackage,
  subagentsPackage,
  kubernetesPackage,
  metaPackage,
].map(({ piCloud }) => piCloud as PluginManifest);

export const serverPlugins: readonly ServerPlugin[] = [
  projects,
  library,
  models,
  kubernetesPlugin,
  meta,
];

const sessionPlugins: readonly SessionPlugin[] = [
  ask,
  changes,
  librarySession,
  modelsSession,
  subagents,
  metaSession,
];

// The Session parts an assignment names, each with its settings. A server
// from before settings sends none, so they take their defaults. An installed
// plugin's part comes from installed, by its bundle's hash.
export async function sessionParts(
  assignment: Pick<
    Assignment,
    "plugins" | "pluginSettings" | "requiredPlugins" | "installedParts"
  >,
  installed: (name: string, hash: string) => Promise<SessionPlugin>,
): Promise<{
  readonly plugins: readonly SessionPlugin[];
  readonly pluginSettings: Readonly<Record<string, PluginSettings>>;
}> {
  const parts = Object.entries(assignment.installedParts ?? {}).filter(
    ([name]) => assignment.plugins.includes(name),
  );

  const unknown = (assignment.requiredPlugins ?? []).filter(
    (name) =>
      !sessionPlugins.some((plugin) => plugin.name === name) &&
      !parts.some(([part]) => part === name),
  );

  if (unknown.length > 0) {
    throw new Error(
      `this runner has no ${unknown.join(", ")} plugin, so it needs an update`,
    );
  }

  const builtIn = sessionPlugins.filter(({ name }) =>
    assignment.plugins.includes(name),
  );

  const fetched = await Promise.all(
    parts.map(async ([name, hash]) => installed(name, hash)),
  );

  return {
    plugins: [...builtIn, ...fetched],
    pluginSettings: Object.fromEntries<PluginSettings>([
      ...builtIn.map(({ name }): [string, PluginSettings] => [
        name,
        settingValues(
          builtInPlugins.find(({ id }) => id === name)?.settings,
          assignment.pluginSettings?.[name],
        ),
      ]),
      ...fetched.map(({ name }): [string, PluginSettings] => [
        name,
        assignment.pluginSettings?.[name] ?? {},
      ]),
    ]),
  };
}

export interface PluginHost {
  // The plugins that are on, without any that failed to register.
  readonly names: readonly string[];
  readonly list: () => readonly PluginInfo[];
  // The plugin's new settings, what is wrong with them, or undefined when no
  // plugin has the name.
  readonly saveSettings: (
    name: string,
    settings: unknown,
  ) => PluginInfo | string | undefined;
  // Turns an installed plugin on or off for the next start.
  readonly turnOn: (
    name: string,
    on: boolean,
  ) => Promise<PluginInfo | string | undefined>;
  // The file of a running installed plugin's web part, by its name.
  readonly webPart: (name: string, file: string) => string | undefined;
  // The file of a running installed plugin's Session part, by its hash.
  readonly sessionPart: (name: string, hash: string) => string | undefined;
  readonly sessionPlugins: () => SessionPlugins;
  readonly profile: (id: string) => PluginProfile | undefined;
  readonly profileIds: () => readonly string[];
  readonly tools: (session: Session) => readonly ToolSpec[];
  readonly call: (session: Session, call: ToolCall) => void;
  // Every toolset's tools, and a call to one as a user, for MCP clients.
  readonly toolsetTools: () => readonly ToolSpec[];
  readonly callToolset: (
    name: string,
    input: unknown,
    actor: UserActor,
  ) => Promise<ToolResult>;
  readonly offeredModels: (environmentId: string) => OfferedModels;
  readonly route: (
    request: Request,
    name: string,
    path: string,
    caller?: ToolCaller,
  ) => Promise<Response | undefined>;
}

function pluginEnvironments(
  sessions: Sessions,
  runners: {
    readonly token: (environment: string, runner: string) => string;
    readonly revoke: (environment: string, runner: string) => void;
  },
): ServerPluginContext["environments"] {
  const provider = (environmentId: string): string => {
    const found = sessions
      .environments()
      .find(({ id }) => id === environmentId);

    if (found === undefined) {
      throw new Error(`no Environment ${environmentId}`);
    }

    return found.provider;
  };

  return {
    list: () => sessions.environments(),
    unplaced: (environmentId) => sessions.unplaced(environmentId),
    runnerToken: (environmentId, runner) =>
      runners.token(provider(environmentId), runner),
    revokeRunner: (environmentId, runner) => {
      runners.revoke(provider(environmentId), runner);
    },
  };
}

export function startPlugins(
  plugins: readonly ServerPlugin[],
  enabled: readonly string[],
  deps: {
    // What the Plugins page lists, on or not.
    readonly manifests: readonly PluginManifest[];
    readonly sessions: Sessions;
    readonly runners: {
      readonly token: (environment: string, runner: string) => string;
      readonly revoke: (environment: string, runner: string) => void;
    };
    readonly events: EventBus;
    readonly store: (name: string) => PluginStore;
    readonly settings: PluginSettingsStore;
    // The kernel's own toolsets (ADR 0035).
    readonly toolsets: readonly Toolset[];
    // Handles a toolset tool's request as the user.
    readonly api: (actor: UserActor, request: Request) => Promise<Response>;
    readonly installed?: InstalledPlugins;
    readonly signal: AbortSignal;
    readonly log: Log;
  },
): PluginHost {
  const tools = new Map<string, { plugin: string; tool: ServerTool }>();
  const routeTools = new Map<string, ToolsetTool>();
  const toolsetUsers = new Set<string>();
  const routes = new Map<string, PluginRoute>();
  const offers: ModelOffer[] = [];

  const failures = new Map<string, string>(
    deps.installed?.plugins.flatMap(({ manifest: { id }, error }) =>
      error === undefined ? [] : [[id, error] as const],
    ),
  );

  const installedIds = new Set(
    deps.installed?.plugins.map(({ manifest: { id } }) => id),
  );

  const webParts = new Map(
    deps.installed?.plugins.flatMap(({ manifest: { id }, web }) =>
      web === undefined ? [] : [[id, web] as const],
    ),
  );

  const sessionBundles = new Map(
    deps.installed?.plugins.flatMap(({ manifest: { id }, session }) =>
      session === undefined ? [] : [[id, session] as const],
    ),
  );

  const switchedOn = new Set(
    deps.installed?.plugins.flatMap(({ manifest: { id }, on }) =>
      on ? [id] : [],
    ),
  );

  const profiles = new Map<string, PluginProfile>();
  const loaded = new Map<string, readonly string[]>();

  const manifest = (name: string): PluginManifest | undefined =>
    deps.manifests.find(({ id }) => id === name);

  const values = (name: string): PluginSettings =>
    settingValues(manifest(name)?.settings, deps.settings.get(name));

  const taken = (name: string): boolean =>
    tools.has(name) || routeTools.has(name);

  // A toolset's namespace has one owner, so its description stays its own.
  const namespaces = new Map<string, string>();

  const claim = (namespace: string, claimant: string): void => {
    const taker = namespaces.get(namespace);
    if (taker !== undefined && taker !== claimant) {
      throw new Error(`toolset ${namespace} belongs to ${taker}`);
    }

    namespaces.set(namespace, claimant);
  };

  for (const { name } of deps.toolsets.map(({ namespace }) => namespace)) {
    claim(name, "kernel");
  }

  for (const tool of deps.toolsets.flatMap((each) => toolsetTools(each))) {
    if (taken(tool.spec.name)) {
      throw new Error(`tool ${tool.spec.name} is already registered`);
    }

    routeTools.set(tool.spec.name, tool);
  }

  const loadsToolsets = (session: Session): boolean =>
    session.owner !== null && toolsetUsers.has(session.owner.plugin);

  for (const plugin of plugins.filter(({ name }) => enabled.includes(name))) {
    const log: Log = (message, fields) => {
      deps.log(message, { plugin: plugin.name, ...fields });
    };

    // What the plugin registers is kept aside until register returns, so a
    // plugin that throws leaves nothing behind in the host (ADR 0036).
    const staged = {
      tools: new Map<string, ServerTool>(),
      routeTools: new Map<string, ToolsetTool>(),
      namespaces: new Set<string>(),
      loadsToolsets: false,
      route: undefined as PluginRoute | undefined,
      offers: [] as ModelOffer[],
      profiles: new Map<string, PluginProfile>(),
      loadOnly: undefined as readonly string[] | undefined,
      unsubscribes: [] as (() => void)[],
    };

    const failed = new AbortController();

    const stagedTaken = (name: string): boolean =>
      taken(name) || staged.tools.has(name) || staged.routeTools.has(name);

    const declared = installedIds.has(plugin.name)
      ? (manifest(plugin.name)?.capabilities ?? [])
      : capabilities;

    try {
      plugin.register(
        limited(plugin.name, declared, {
          owner,
          tools: {
            register: (tool) => {
              if (stagedTaken(tool.name)) {
                throw new Error(`tool ${tool.name} is already registered`);
              }

              staged.tools.set(tool.name, tool);
            },
          },
          toolsets: {
            register: (toolset) => {
              const taker = namespaces.get(toolset.namespace.name);
              if (taker !== undefined && taker !== plugin.name) {
                throw new Error(
                  `toolset ${toolset.namespace.name} belongs to ${taker}`,
                );
              }

              staged.namespaces.add(toolset.namespace.name);

              for (const tool of toolsetTools(toolset, plugin.name)) {
                if (stagedTaken(tool.spec.name)) {
                  throw new Error(
                    `tool ${tool.spec.name} is already registered`,
                  );
                }

                staged.routeTools.set(tool.spec.name, tool);
              }
            },
            loadInOwnSessions: () => {
              staged.loadsToolsets = true;
            },
          },
          events: {
            publish: deps.events.publish,
            subscribe: (type, listener) => {
              const unsubscribe = deps.events.subscribe(type, listener);
              staged.unsubscribes.push(unsubscribe);

              return unsubscribe;
            },
          },
          sessions: pluginSessions(deps.sessions, plugin.name, (names) => {
            staged.loadOnly = names;
          }),
          environments: pluginEnvironments(deps.sessions, deps.runners),
          profiles: {
            provide: (key, { name: _name, ...content }) => {
              const id = `${plugin.name}.${key}`;

              staged.profiles.set(id, {
                plugin: plugin.name,
                profile: { id, ...content },
              });

              return id;
            },
          },
          routes: {
            handle: (route) => {
              staged.route = route;
            },
          },
          models: {
            offer: (offer) => {
              staged.offers.push(offer);
            },
          },
          store: deps.store(plugin.name),
          settings: { get: () => values(plugin.name) },
          signal: AbortSignal.any([deps.signal, failed.signal]),
          log,
        }),
      );
    } catch (error) {
      for (const unsubscribe of staged.unsubscribes) {
        unsubscribe();
      }

      failed.abort();

      const message = error instanceof Error ? error.message : String(error);
      failures.set(plugin.name, message);
      log("plugin failed to register", { error: message });

      continue;
    }

    for (const [name, tool] of staged.tools) {
      tools.set(name, { plugin: plugin.name, tool });
    }

    for (const namespace of staged.namespaces) {
      claim(namespace, plugin.name);
    }

    for (const [name, tool] of staged.routeTools) {
      routeTools.set(name, tool);
    }

    if (staged.loadsToolsets) {
      toolsetUsers.add(plugin.name);
    }

    if (staged.route !== undefined) {
      routes.set(plugin.name, staged.route);
    }

    offers.push(...staged.offers);

    for (const [id, profile] of staged.profiles) {
      profiles.set(id, profile);
    }

    if (staged.loadOnly !== undefined) {
      loaded.set(plugin.name, staged.loadOnly);
    }

    deps.log("plugin registered", { plugin: plugin.name });
  }

  const running = enabled.filter((name) => !failures.has(name));

  const info = (found: PluginManifest): PluginInfo => {
    const error = failures.get(found.id);
    const installed = installedIds.has(found.id);

    const base = {
      ...found,
      source: installed ? "installed" : "built-in",
      turnedOn: installed
        ? switchedOn.has(found.id)
        : enabled.includes(found.id),
      values: values(found.id),
    } as const;

    if (error !== undefined) {
      return { ...base, state: "failed", error };
    }

    const web = webParts.get(found.id);

    return running.includes(found.id)
      ? {
          ...base,
          state: "on",
          ...(web !== undefined && {
            webPart: `/api/plugin-parts/${found.id}/${basename(web)}`,
          }),
        }
      : { ...base, state: "off" };
  };

  return {
    names: running,
    list: () => deps.manifests.map(info),
    saveSettings: (name, settings) => {
      const found = manifest(name);
      if (found === undefined) {
        return undefined;
      }

      const checked = checkedSettings(found.settings, settings);
      if (typeof checked === "string") {
        return checked;
      }

      deps.settings.set(name, checked);
      deps.log("plugin settings saved", { plugin: name });

      return info(found);
    },
    turnOn: async (name, on) => {
      const found = manifest(name);
      if (found === undefined) {
        return undefined;
      }

      if (deps.installed === undefined || !installedIds.has(name)) {
        return "only an installed plugin can be turned on or off here";
      }

      const error = failures.get(name);
      if (on && error !== undefined && !switchedOn.has(name)) {
        return `fix its manifest first: ${error}`;
      }

      await deps.installed.turnOn(name, on);

      if (on) {
        switchedOn.add(name);
      } else {
        switchedOn.delete(name);
      }

      deps.log("plugin turned on or off", { plugin: name, on });

      return info(found);
    },
    webPart: (name, file) => {
      const web = webParts.get(name);

      return running.includes(name) &&
        web !== undefined &&
        basename(web) === file
        ? web
        : undefined;
    },
    sessionPart: (name, hash) => {
      const bundle = sessionBundles.get(name);

      return running.includes(name) && bundle?.hash === hash
        ? bundle.path
        : undefined;
    },
    sessionPlugins: () => {
      return {
        plugins: running,
        pluginSettings: Object.fromEntries(
          running.map((name) => [name, values(name)]),
        ),
        ownSessionsOnly: sessionPlugins
          .filter(({ ownSessionsOnly: own }) => own === true)
          .map(({ name }) => name),
        loadOnly: Object.fromEntries(loaded),
        installedParts: Object.fromEntries(
          [...sessionBundles]
            .filter(([name]) => running.includes(name))
            .map(([name, { hash }]) => [name, hash]),
        ),
      };
    },
    profile: (id) => profiles.get(id),
    profileIds: () => [...profiles.keys()],
    tools: (session) => [
      ...[...tools.values()]
        .filter(({ tool }) => tool.appliesTo(session))
        .map(({ tool: { appliesTo: _appliesTo, run: _run, ...spec } }) => spec),
      ...(loadsToolsets(session)
        ? [...routeTools.values()].map(({ spec }) => spec)
        : []),
    ],
    call: (session, call) => {
      const actor: Actor = `session:${session.id}`;

      deps.events.publish({
        type: "ToolCalled",
        session,
        tool: call.name,
        actor,
      });

      const routed = loadsToolsets(session)
        ? routeTools.get(call.name)
        : undefined;

      const found = tools.get(call.name);

      const result = async (): Promise<ToolResult> => {
        if (routed !== undefined) {
          return runRouteTool(
            routed,
            call.input,
            `user:${session.ownerId}`,
            deps,
            (action) => {
              deps.sessions.publish(session.id, {
                generation: call.generation,
                events: [{ type: "ui_action", action }],
              });
            },
          );
        }

        return found?.tool.appliesTo(session) === true
          ? found.tool.run(call.input, { session, actor })
          : Promise.resolve({
              text: `no tool named ${call.name}`,
              isError: true,
            });
      };

      const plugin = routed === undefined ? found?.plugin : routed.plugin;

      void result()
        .catch((error: unknown) => ({ text: String(error), isError: true }))
        .then((reply) => {
          sendResult(deps, session.id, call, {
            actor: `plugin:${plugin ?? "kernel"}`,
            type: "tool_result",
            id: call.id,
            result: reply,
          });
        });
    },
    toolsetTools: () => [...routeTools.values()].map(({ spec }) => spec),
    callToolset: async (name, input, actor) => {
      const found = routeTools.get(name);

      return found === undefined
        ? { text: `no tool named ${name}`, isError: true }
        : runRouteTool(found, input, actor, deps, () => undefined).catch(
            (error: unknown) => ({ text: String(error), isError: true }),
          );
    },
    offeredModels: (environmentId) => {
      const offered = offers.map((offer) => offer(environmentId));
      const fallback = offered.find((each) => each.default)?.default;

      return {
        models: offered.flatMap((each) => each.models),
        ...(fallback && { default: fallback }),
      };
    },
    route: async (request, name, path, caller) =>
      routes.get(name)?.(request, path, caller),
  };
}

type UserActor = `user:${string}`;

interface ToolsetTool {
  // Undefined for the kernel's own toolsets.
  readonly plugin: string | undefined;
  readonly spec: ToolSpec;
  readonly tool: RouteTool;
}

function toolsetTools(toolset: Toolset, plugin?: string): ToolsetTool[] {
  const namespace: ToolNamespace = toolset.namespace;

  return toolset.tools.map((tool) => {
    const { request: _request, result: _result, opens: _opens, ...spec } = tool;

    return {
      plugin,
      tool,
      spec: {
        ...spec,
        name: `${namespace.name}_${tool.name}`,
        exposure: tool.exposure ?? "deferred",
        namespace,
      },
    };
  });
}

// A route of the web app such as a Session id or <project id>/<thread id>,
// so what a tool opens stays a page of Pi Cloud.
const appRoute = /^[\w-]+(\/[\w-]+)*$/;

// Never sent anywhere: the request goes straight to the server's handler.
const internalOrigin = "http://pi-cloud.internal";

async function runRouteTool(
  found: ToolsetTool,
  input: unknown,
  actor: UserActor,
  deps: {
    readonly api: (actor: UserActor, request: Request) => Promise<Response>;
  },
  open: (action: UiAction) => void,
): Promise<ToolResult> {
  const { method, path, body } = found.tool.request(
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {},
  );

  const base =
    found.plugin === undefined ? "/api/" : `/api/plugins/${found.plugin}/`;

  const url = routeUrl(found.plugin === undefined ? path : base + path, base);

  if (url === undefined) {
    return { text: `${path} isn't one of its routes`, isError: true };
  }

  const response = await deps.api(
    actor,
    new Request(
      url,
      body === undefined
        ? { method }
        : {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    ),
  );

  const text = await response.text();

  if (!response.ok) {
    return {
      text: text || `failed with ${String(response.status)}`,
      isError: true,
    };
  }

  if (text === "") {
    return { text: "Done.", isError: false };
  }

  // The change is made by now, so a reply the tool can't read is still a
  // success; an error would make the model try again.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, isError: false };
  }

  try {
    const opened = found.tool.opens?.(parsed);

    if (opened !== undefined && appRoute.test(opened.route)) {
      open({
        kind: "open",
        route:
          found.plugin === undefined
            ? opened.route
            : `plugin/${found.plugin}/${opened.route}`,
        label: opened.label,
      });
    }

    return {
      text: JSON.stringify(
        found.tool.result ? found.tool.result(parsed) : parsed,
      ),
      isError: false,
    };
  } catch {
    return { text: "Done, with a reply it couldn't show.", isError: false };
  }
}

// A tool's path stays under its own routes: dot segments, plain or
// percent-encoded, would let input such as an id name another route.
function routeUrl(path: string, base: string): string | undefined {
  const [pathname = ""] = path.split("?");

  const dotted = pathname.split("/").some((segment) => {
    try {
      return [".", ".."].includes(decodeURIComponent(segment));
    } catch {
      return true;
    }
  });

  const url = new URL(path, internalOrigin);

  return dotted || !url.pathname.startsWith(base) ? undefined : url.href;
}

function pluginSessions(
  sessions: Sessions,
  plugin: string,
  loadOnly: (plugins: readonly string[]) => void,
): ServerPluginContext["sessions"] {
  const ownedHere = (id: string): string => {
    if (sessions.get(id)?.owner?.plugin !== plugin) {
      throw new Error(`session ${id} isn't owned by ${plugin}`);
    }

    return id;
  };

  const settle = (
    outcome:
      { readonly ok: true } | { readonly ok: false; readonly reason: string },
    done: string,
  ): void => {
    if (!outcome.ok) {
      throw new Error(`session not ${done}: ${outcome.reason}`);
    }
  };

  return {
    loadOnly,
    start: (request, ownerKey) => {
      const started = sessions.start(
        request,
        ownerKey === undefined ? undefined : { plugin, key: ownerKey },
      );

      if (!started.ok) {
        throw new Error(`session not started: ${started.reason}`);
      }

      return started.value;
    },
    get: (id) => sessions.get(id),
    owned: (key, { archived = false } = {}) =>
      sessions.list({ archived, owner: { plugin, key } }),
    adopt: (id, key) => {
      sessions.adopt(id, { plugin, key });
    },
    archive: (id) => {
      settle(sessions.archive(ownedHere(id)), "archived");
    },
    unarchive: (id) => {
      settle(sessions.unarchive(ownedHere(id)), "unarchived");
    },
    send: (id, text, actor, notice) =>
      sessions.send(
        id,
        notice
          ? {
              actor,
              type: "notice",
              text,
              notice: { plugin, ...notice },
              turn: true,
            }
          : { actor, type: "message", text, delivery: "followUp" },
      ),
    notify: (id, text, actor, notice) =>
      sessions.send(
        id,
        notice
          ? {
              actor,
              type: "notice",
              text,
              notice: { plugin, ...notice },
              turn: false,
            }
          : { actor, type: "context", text },
      ),
    transcript: (id) => sessions.transcript(id),
    transcriptLength: (id) => sessions.transcriptLength(id),
  };
}

const resultRetryMs = 1000;

// A result that finds the command stream reconnecting waits for the same
// attempt to come back. Like the projects outbox (ADR 0016), this holds only
// what the server sends, never user input (ADR 0006).
function sendResult(
  deps: {
    readonly sessions: Sessions;
    readonly runners: {
      readonly token: (environment: string, runner: string) => string;
      readonly revoke: (environment: string, runner: string) => void;
    };
    readonly signal: AbortSignal;
    readonly log: Log;
  },
  sessionId: string,
  call: ToolCall,
  command: Command,
): void {
  const fields = {
    sessionId,
    generation: call.generation,
    tool: call.name,
    callId: call.id,
  };

  const send = (): Result<undefined> =>
    deps.sessions.isCurrent(sessionId, call.generation)
      ? deps.sessions.send(sessionId, command)
      : { ok: false, reason: "stale_generation" };

  const sent = send();
  if (sent.ok) {
    return;
  }

  if (sent.reason !== "offline") {
    deps.log("tool result dropped", { ...fields, reason: sent.reason });

    return;
  }

  if (deps.signal.aborted) {
    return;
  }

  deps.log("tool result waiting for the session", fields);

  const stop = (): void => {
    clearInterval(retry);
    deps.signal.removeEventListener("abort", stop);
  };

  const retry = setInterval(() => {
    const resent = send();
    if (!resent.ok && resent.reason === "offline") {
      return;
    }

    stop();

    if (resent.ok) {
      deps.log("tool result delivered", fields);
    } else {
      deps.log("tool result dropped", { ...fields, reason: resent.reason });
    }
  }, resultRetryMs);

  deps.signal.addEventListener("abort", stop);
}

export interface InstalledPlugins {
  readonly plugins: readonly {
    readonly manifest: PluginManifest;
    readonly on: boolean;
    readonly web?: string;
    readonly session?: { readonly path: string; readonly hash: string };
    readonly error?: string;
  }[];
  readonly turnOn: (id: string, on: boolean) => Promise<void>;
}

// An installed plugin reaches only the parts of its context it declared, so a
// mistake shows when it registers. It isn't a sandbox: the plugin runs in the
// server's process (ADR 0022).
function limited(
  plugin: string,
  declared: readonly Capability[],
  context: ServerPluginContext,
): ServerPluginContext {
  return new Proxy(context, {
    get: (target, key, receiver) => {
      const capability = capabilities.find((each) => each === key);

      if (capability !== undefined && !declared.includes(capability)) {
        throw new Error(
          `${plugin} uses ${capability} without declaring it in piCloud.capabilities`,
        );
      }

      return Reflect.get(target, key, receiver) as unknown;
    },
  });
}
