import { ask } from "@pi-cloud/ask/session";
import { changes } from "@pi-cloud/changes/session";
import { library as librarySession } from "@pi-cloud/library/session";
import { kubernetesPlugin } from "@pi-cloud/kubernetes/server";
import { library } from "@pi-cloud/library/server";
import { models as modelsSession } from "@pi-cloud/models/session";
import { models } from "@pi-cloud/models/server";
import { projects } from "@pi-cloud/projects/server";
import { subagents } from "@pi-cloud/subagents/session";
import type {
  EventBus,
  ModelOffer,
  OfferedModels,
  PluginRoute,
  PluginStore,
  ServerPlugin,
  ServerPluginContext,
  ServerTool,
  ToolCaller,
  SessionPlugin,
} from "@pi-cloud/plugins";
import type {
  Actor,
  Command,
  Session,
  ToolCall,
  ToolSpec,
} from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";
import { owner, type Result, type Sessions } from "@pi-cloud/sessions";

// The plugins built into this binary (ADR 0015). Each app imports its own
// parts statically, so the compiled binary needs no dynamic loading.
export const builtInPlugins: readonly string[] = [
  "ask",
  "changes",
  "usage",
  "projects",
  "library",
  "models",
  "subagents",
  "kubernetes",
];

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

export function sessionPluginsNamed(
  enabled: readonly string[],
): readonly SessionPlugin[] {
  return sessionPlugins.filter(({ name }) => enabled.includes(name));
}

export interface PluginHost {
  readonly names: readonly string[];
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
    reserve: (sessionId, runner) => {
      sessions.reserve(sessionId, runner);
    },
  };
}

export function startPlugins(
  plugins: readonly ServerPlugin[],
  enabled: readonly string[],
  deps: {
    readonly sessions: Sessions;
    readonly runners: {
      readonly token: (environment: string, runner: string) => string;
      readonly revoke: (environment: string, runner: string) => void;
    };
    readonly events: EventBus;
    readonly store: (name: string) => PluginStore;
    readonly signal: AbortSignal;
    readonly log: Log;
  },
): PluginHost {
  const tools = new Map<string, { plugin: string; tool: ServerTool }>();
  const routes = new Map<string, PluginRoute>();
  const offers: ModelOffer[] = [];
  for (const plugin of plugins.filter(({ name }) => enabled.includes(name))) {
    const log: Log = (message, fields) => {
      deps.log(message, { plugin: plugin.name, ...fields });
    };

    plugin.register({
      owner,
      tools: {
        register: (tool) => {
          if (tools.has(tool.name)) {
            throw new Error(`tool ${tool.name} is already registered`);
          }

          tools.set(tool.name, { plugin: plugin.name, tool });
        },
      },
      events: deps.events,
      sessions: pluginSessions(deps.sessions, plugin.name),
      environments: pluginEnvironments(deps.sessions, deps.runners),
      routes: {
        handle: (route) => {
          routes.set(plugin.name, route);
        },
      },
      models: {
        offer: (offer) => {
          offers.push(offer);
        },
      },
      store: deps.store(plugin.name),
      signal: deps.signal,
      log,
    });

    deps.log("plugin registered", { plugin: plugin.name });
  }

  return {
    names: enabled,
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
