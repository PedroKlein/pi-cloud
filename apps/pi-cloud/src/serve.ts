import { eventBus, type ServerPlugin } from "@pi-cloud/plugins";
import type { Log } from "@pi-cloud/providers";
import { Profiles } from "@pi-cloud/profiles";
import { owner, Sessions, type SessionsOptions } from "@pi-cloud/sessions";
import web from "@pi-cloud/web/index.html";
import { type AgentOptions, runAgent } from "./agent";
import { builtInPlugins, serverPlugins, startPlugins } from "./plugins";
import { createHandler } from "./server";
import { openStore } from "./store";
import { terminalBroker } from "./terminals";

export interface ServeOptions {
  readonly port: number;
  readonly database: string;
  readonly sessions?: SessionsOptions;
  readonly agent?: Omit<AgentOptions, "server" | "log" | "signal">;
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

  const handler = createHandler(
    sessions,
    new Profiles(store, owner),
    pluginHost,
    store.check,
    options.log,
  );

  const terminals = terminalBroker(sessions, options.log);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 30,
    development: false,
    routes: { "/": web },
    fetch: async (request, bunServer) => {
      if (!fromThisSite(request)) {
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
  const agentStop = new AbortController();

  // The built-in provider is the same agent a laptop runs, talking to this
  // server over loopback, so both providers share one tested path.
  const agent =
    options.agent &&
    runAgent({
      ...options.agent,
      server: server.url.href,
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

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Docker Desktop and colima containers reach the runner's own loopback, where
// a laptop's server listens, under this name. A browser may resolve it through
// DNS, so for it only a runner's calls count, which a browser page can't make
// without sending an Origin.
const dockerHost = "host.docker.internal";

// Without auth, a page on another site, or one reached by DNS rebinding,
// could otherwise drive sessions and terminals from the user's browser.
function fromThisSite(request: Request): boolean {
  const host = request.headers.get("host") ?? "";
  const origin = request.headers.get("origin");

  if (
    URL.canParse(`http://${host}`) &&
    new URL(`http://${host}`).hostname === dockerHost
  ) {
    return (
      origin === null && new URL(request.url).pathname.startsWith("/agent/")
    );
  }

  return (
    URL.canParse(`http://${host}`) &&
    loopback.has(new URL(`http://${host}`).hostname) &&
    (origin === null || (URL.canParse(origin) && new URL(origin).host === host))
  );
}
