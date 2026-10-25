import { eventBus, type ServerPlugin } from "@pi-cloud/plugins";
import type { Log } from "@pi-cloud/providers";
import { Profiles } from "@pi-cloud/profiles";
import { owner, Sessions, type SessionsOptions } from "@pi-cloud/sessions";
import web from "@pi-cloud/web/index.html";
import { type AgentOptions, runAgent } from "./agent";
import { Auth } from "./auth";
import { builtInPlugins, serverPlugins, startPlugins } from "./plugins";
import { createHandler } from "./server";
import { openStore } from "./store";
import { terminalBroker } from "./terminals";

export interface ServeOptions {
  // 127.0.0.1 unless a proxy or other machines reach the server directly.
  readonly hostname?: string;
  readonly port: number;
  // Where people open the server, for the setup link, when that isn't where
  // it listens, such as behind a gateway.
  readonly url?: URL;
  readonly database: string;
  readonly sessions?: SessionsOptions;
  readonly agent?: Omit<
    AgentOptions,
    "server" | "credential" | "log" | "signal"
  >;
  readonly plugins?: readonly ServerPlugin[];
  readonly disabledPlugins?: readonly string[];
  readonly log: Log;
}

export function serve(options: ServeOptions): {
  readonly url: URL;
  readonly stop: () => Promise<void>;
} {
  const store = openStore(options.database);
  const plugins = options.plugins ?? serverPlugins;
  const disabled = options.disabledPlugins ?? [];

  const enabled = (
    options.plugins?.map(({ name }) => name) ?? builtInPlugins
  ).filter((name) => !disabled.includes(name));

  const events = eventBus((type, error) => {
    options.log("event listener failed", { type, error: String(error) });
  });

  const sessions = new Sessions(store, {
    ...options.sessions,
    events: events.publish,
    sessionPlugins: enabled,
    offeredModels: (environmentId) => pluginHost.offeredModels(environmentId),
  });

  const pluginsStop = new AbortController();

  const pluginHost = startPlugins(plugins, enabled, {
    sessions,
    events,
    store: store.plugin,
    signal: pluginsStop.signal,
    log: options.log,
  });

  const auth = new Auth(store.auth);

  const handler = createHandler(
    auth,
    sessions,
    new Profiles(store, owner),
    pluginHost,
    store.check,
    options.log,
  );

  const terminals = terminalBroker(sessions, auth, options.log);

  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    idleTimeout: 30,
    development: false,
    routes: { "/": web },
    fetch: async (request, bunServer) => {
      if (!sameOrigin(request)) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }

      const upgraded = terminals.upgrade(request, bunServer);
      if (upgraded === "upgraded") {
        return undefined;
      }

      return upgraded ?? handler(request);
    },
    websocket: terminals.websocket,
  });

  options.log("server listening", { url: server.url.href });

  if (auth.setupToken !== undefined) {
    options.log("open the setup link to create the first user", {
      link: new URL(`/#setup/${auth.setupToken}`, options.url ?? server.url)
        .href,
    });
  }

  const agentStop = new AbortController();

  // The built-in provider is the same agent a laptop runs, talking to this
  // server over loopback, so both providers share one tested path.
  const ownRunner = options.agent?.provider;
  if (ownRunner !== undefined) {
    store.ensureEnvironment(ownRunner);
  }

  const agent =
    options.agent &&
    runAgent({
      ...options.agent,
      server: server.url.href,
      credential: {
        token: auth.ownRunnerToken(
          options.agent.provider,
          options.agent.provider,
        ),
      },
      log: options.log,
      signal: agentStop.signal,
    });

  return {
    url: server.url,
    stop: async () => {
      agentStop.abort();
      pluginsStop.abort();
      await agent;
      await server.stop(true);
      sessions.close();
      store.close();
      options.log("server stopped");
    },
  };
}

// Browser sessions and runners carry their own credentials (ADR 0033). A
// cross-site page can't send the SameSite cookie, so this only refuses what a
// browser says came from another site.
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");

  return (
    origin === null ||
    (URL.canParse(origin) &&
      new URL(origin).host === request.headers.get("host"))
  );
}
