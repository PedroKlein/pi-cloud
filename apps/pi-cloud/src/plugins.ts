import askPackage from "@pi-cloud/ask/package.json";
import { ask } from "@pi-cloud/ask/session";
import changesPackage from "@pi-cloud/changes/package.json";
import { changes } from "@pi-cloud/changes/session";
import kubernetesPackage from "@pi-cloud/kubernetes/package.json";
import { kubernetesPlugin } from "@pi-cloud/kubernetes/server";
import libraryPackage from "@pi-cloud/library/package.json";
import { library } from "@pi-cloud/library/server";
import { library as librarySession } from "@pi-cloud/library/session";
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
  type ServerPlugin,
  type ServerPluginContext,
  type ServerTool,
  type SessionPlugin,
  settingValues,
  type ToolCaller,
} from "@pi-cloud/plugins";
import type {
  Actor,
  Assignment,
  Command,
  PluginInfo,
  PluginManifest,
  PluginSettings,
  Session,
  ToolCall,
  ToolSpec,
} from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";
import {
  owner,
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
].map(({ piCloud }) => piCloud as PluginManifest);

export const serverPlugins: readonly ServerPlugin[] = [
  projects,
  library,
  models,
  kubernetesPlugin,
];

const sessionPlugins: readonly SessionPlugin[] = [
  ask,
  changes,
  librarySession,
  modelsSession,
  subagents,
];

// The Session parts an assignment names, each with its settings. A server
// from before settings sends none, so they take their defaults.
export function sessionParts(
  assignment: Pick<Assignment, "plugins" | "pluginSettings">,
): {
  readonly plugins: readonly SessionPlugin[];
  readonly pluginSettings: Readonly<Record<string, PluginSettings>>;
} {
  const plugins = sessionPlugins.filter(({ name }) =>
    assignment.plugins.includes(name),
  );

  return {
    plugins,
    pluginSettings: Object.fromEntries(
      plugins.map(({ name }) => [
        name,
        settingValues(
          builtInPlugins.find(({ id }) => id === name)?.settings,
          assignment.pluginSettings?.[name],
        ),
      ]),
    ),
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
  readonly sessionPlugins: () => SessionPlugins;
  readonly tools: (session: Session) => readonly ToolSpec[];
  readonly call: (session: Session, call: ToolCall) => void;
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
    readonly signal: AbortSignal;
    readonly log: Log;
  },
): PluginHost {
  const tools = new Map<string, { plugin: string; tool: ServerTool }>();
  const routes = new Map<string, PluginRoute>();
  const offers: ModelOffer[] = [];
  const failures = new Map<string, string>();

  const manifest = (name: string): PluginManifest | undefined =>
    deps.manifests.find(({ id }) => id === name);

  const values = (name: string): PluginSettings =>
    settingValues(manifest(name)?.settings, deps.settings.get(name));

  for (const plugin of plugins.filter(({ name }) => enabled.includes(name))) {
    const log: Log = (message, fields) => {
      deps.log(message, { plugin: plugin.name, ...fields });
    };

    // What the plugin registers is kept aside until register returns, so a
    // plugin that throws leaves nothing behind in the host (ADR 0036).
    const staged = {
      tools: new Map<string, ServerTool>(),
      route: undefined as PluginRoute | undefined,
      offers: [] as ModelOffer[],
      unsubscribes: [] as (() => void)[],
    };

    const failed = new AbortController();

    try {
      plugin.register({
        owner,
        tools: {
          register: (tool) => {
            if (tools.has(tool.name) || staged.tools.has(tool.name)) {
              throw new Error(`tool ${tool.name} is already registered`);
            }

            staged.tools.set(tool.name, tool);
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
        sessions: pluginSessions(deps.sessions, plugin.name),
        environments: pluginEnvironments(deps.sessions, deps.runners),
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
      });
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

    if (staged.route !== undefined) {
      routes.set(plugin.name, staged.route);
    }

    offers.push(...staged.offers);

    deps.log("plugin registered", { plugin: plugin.name });
  }

  const running = enabled.filter((name) => !failures.has(name));

  const info = (found: PluginManifest): PluginInfo => {
    const error = failures.get(found.id);
    const base = { ...found, values: values(found.id) };

    if (error !== undefined) {
      return { ...base, state: "failed", error };
    }

    return { ...base, state: running.includes(found.id) ? "on" : "off" };
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
    sessionPlugins: () => ({
      plugins: running,
      pluginSettings: Object.fromEntries(
        running.map((name) => [name, values(name)]),
      ),
    }),
    tools: (session) =>
      [...tools.values()]
        .filter(({ tool }) => tool.appliesTo(session))
        .map(({ tool: { name, description, parameters } }) => ({
          name,
          description,
          parameters,
        })),
    call: (session, call) => {
      const actor: Actor = `session:${session.id}`;
      const found = tools.get(call.name);

      deps.events.publish({
        type: "ToolCalled",
        session,
        tool: call.name,
        actor,
      });

      const result =
        found?.tool.appliesTo(session) === true
          ? found.tool.run(call.input, { session, actor })
          : Promise.resolve({
              text: `no tool named ${call.name}`,
              isError: true,
            });

      void result
        .catch((error: unknown) => ({ text: String(error), isError: true }))
        .then((reply) => {
          sendResult(deps, session.id, call, {
            actor: `plugin:${found?.plugin ?? "kernel"}`,
            type: "tool_result",
            id: call.id,
            result: reply,
          });
        });
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

function pluginSessions(
  sessions: Sessions,
  plugin: string,
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
