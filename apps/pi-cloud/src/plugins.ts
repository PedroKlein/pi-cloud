import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type {
  EventBus,
  PluginRoute,
  PluginStore,
  ServerPlugin,
  ServerTool,
  SessionPlugin,
} from "@pi-cloud/plugins";
import type { Actor, Session, ToolCall, ToolSpec } from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";
import type { Sessions } from "@pi-cloud/sessions";

// The plugins built into this binary (ADR 0015). Each app imports its own
// parts statically, so the compiled binary needs no dynamic loading.
export const serverPlugins: readonly ServerPlugin[] = [];
export const sessionPlugins: readonly SessionPlugin[] = [];

export function sessionExtensions(
  enabled: readonly string[],
): ExtensionFactory[] {
  return sessionPlugins
    .filter(({ name }) => enabled.includes(name))
    .map(({ extension }) => extension);
}

export interface PluginHost {
  readonly names: readonly string[];
  readonly tools: (session: Session) => readonly ToolSpec[];
  readonly call: (session: Session, call: ToolCall) => void;
  readonly route: (
    request: Request,
    name: string,
    path: string,
  ) => Promise<Response | undefined>;
}

export function startPlugins(
  plugins: readonly ServerPlugin[],
  disabled: readonly string[],
  deps: {
    readonly sessions: Sessions;
    readonly events: EventBus;
    readonly store: (name: string) => PluginStore;
    readonly log: Log;
  },
): PluginHost {
  const tools = new Map<string, { plugin: string; tool: ServerTool }>();
  const routes = new Map<string, PluginRoute>();
  const enabled = plugins.filter(({ name }) => !disabled.includes(name));

  for (const plugin of enabled) {
    const log: Log = (message, fields) => {
      deps.log(message, { plugin: plugin.name, ...fields });
    };

    plugin.register({
      tools: {
        register: (tool) => {
          if (tools.has(tool.name)) {
            throw new Error(`tool ${tool.name} is already registered`);
          }

          tools.set(tool.name, { plugin: plugin.name, tool });
        },
      },
      events: deps.events,
      sessions: {
        start: (request) => {
          const started = deps.sessions.start(request);
          if (!started.ok) {
            throw new Error(`session not started: ${started.reason}`);
          }

          return started.value;
        },
        get: (id) => deps.sessions.get(id),
        send: (id, text, actor) => {
          const sent = deps.sessions.send(id, { actor, type: "message", text });
          if (!sent.ok) {
            throw new Error(`message not sent: ${sent.reason}`);
          }
        },
        transcript: (id) => deps.sessions.transcript(id),
      },
      routes: {
        handle: (route) => {
          routes.set(plugin.name, route);
        },
      },
      store: deps.store(plugin.name),
      log,
    });

    deps.log("plugin registered", { plugin: plugin.name });
  }

  return {
    names: enabled.map(({ name }) => name),
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
          deps.sessions.send(session.id, {
            actor: `plugin:${found?.plugin ?? "kernel"}`,
            type: "tool_result",
            id: call.id,
            result: reply,
          });
        });
    },
    route: async (request, name, path) => routes.get(name)?.(request, path),
  };
}
