import type { ServerWebSocket } from "bun";
import { eventBus, type ServerPlugin } from "@pi-cloud/plugins";
import type { PluginManifest } from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";
import { Profiles } from "@pi-cloud/profiles";
import { owner, Sessions, type SessionsOptions } from "@pi-cloud/sessions";
import web from "@pi-cloud/web/index.html";
import { type AgentOptions, runAgent } from "./agent";
import { Auth } from "./auth";
import {
  buildPlugin,
  pluginFiles,
  readPluginFile,
  writePluginFile,
} from "./in-place";
import {
  type InstalledPlugin,
  install,
  remove,
  reread,
  turnOn,
  update,
} from "./installed";
import { builtInPlugins, serverPlugins, startPlugins } from "./plugins";
import { previewBroker } from "./previews";
import { createHandler, onBehalfOf } from "./server";
import { kernelToolsets } from "./toolsets";
import type { PreviewData, SocketData, TerminalData } from "./sockets";
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
  // Encrypts Environment secrets; a file next to the database when unset.
  readonly secretKey?: Buffer;
  // False leaves only the setup link and plugin logins, such as OIDC.
  readonly passwordLogin?: boolean;
  readonly sessions?: SessionsOptions;
  readonly agent?: Omit<
    AgentOptions,
    "server" | "credential" | "log" | "signal"
  >;
  // Replaces the built-in plugins. A plugin without a manifest gets one with
  // just its name.
  readonly plugins?: readonly ServerPlugin[];
  readonly manifests?: readonly PluginManifest[];
  readonly disabledPlugins?: readonly string[];
  // The plugins folder and what was found in it (ADR 0022).
  readonly installed?: {
    readonly root: string;
    readonly plugins: readonly InstalledPlugin[];
  };
  // Exits so that whatever runs the server starts it again. Without it the
  // server can't restart itself.
  readonly restart?: () => void;
  readonly log: Log;
}

export function serve(options: ServeOptions): {
  readonly url: URL;
  readonly stop: () => Promise<void>;
} {
  const store = openStore(options.database, options.secretKey);
  const disabled = options.disabledPlugins ?? [];
  const folder = options.installed;
  const installed = folder?.plugins ?? [];

  const plugins = [
    ...(options.plugins ?? serverPlugins),
    ...installed.flatMap(({ server }) => (server ? [server] : [])),
  ];

  const builtIn =
    options.plugins?.map(
      ({ name }) =>
        options.manifests?.find(({ id }) => id === name) ?? {
          id: name,
          title: name,
          description: "",
        },
    ) ?? builtInPlugins;

  const known = [...builtIn, ...installed.map(({ manifest }) => manifest)];

  const enabled = [
    ...builtIn.map(({ id }) => id).filter((name) => !disabled.includes(name)),
    ...installed.flatMap(({ manifest: { id }, on }) => (on ? [id] : [])),
  ];

  const events = eventBus((type, error) => {
    options.log("event listener failed", { type, error: String(error) });
  });

  const sessions = new Sessions(store, {
    ...options.sessions,
    events: events.publish,
    sessionPlugins: () => pluginHost.sessionPlugins(),
    offeredModels: (environmentId) => pluginHost.offeredModels(environmentId),
    pluginProfile: (id) => pluginHost.profile(id),
  });

  const pluginsStop = new AbortController();
  const auth = new Auth(store.auth, options.passwordLogin);

  const pluginHost = startPlugins(plugins, enabled, {
    manifests: known,
    sessions,
    runners: {
      token: (environment, runner) => auth.runnerToken(environment, runner),
      revoke: (environment, runner) => {
        auth.revokeRunner(environment, runner);
      },
    },
    events,
    store: store.plugin,
    settings: store.pluginSettings,
    toolsets: kernelToolsets,
    api: async (actor, request) => handler(onBehalfOf(actor, request)),
    auth: {
      userOf: (request) => auth.userOf(request),
      createUser: (name, admin) => auth.createUser(name, admin),
      setAdmin: (userId, admin) => {
        auth.setAdmin(userId, admin);
      },
      startSession: (userId, request) => {
        const user = auth.userById(userId);

        return user && auth.startSession(user, request);
      },
    },
    ...(folder && {
      installed: {
        plugins: installed,
        turnOn: async (id, on) => turnOn(folder.root, id, on),
        install: async (url, taken) => install(folder.root, url, taken),
        update: async (id) => update(folder.root, id),
        remove: async (id) => remove(folder.root, id),
        reread: async (id) => reread(folder.root, id),
        files: async (id) => pluginFiles(folder.root, id),
        read: async (id, path) => readPluginFile(folder.root, id, path),
        write: async (id, path, content) =>
          writePluginFile(folder.root, id, path, content),
        build: async (id) => buildPlugin(folder.root, id),
      },
    }),
    signal: pluginsStop.signal,
    log: options.log,
  });

  const handler = createHandler(
    auth,
    sessions,
    new Profiles(store, owner),
    pluginHost,
    store.check,
    options.log,
    options.restart && {
      busy: () =>
        sessions
          .list()
          .filter(
            ({ provider, status }) =>
              provider === options.agent?.provider && status === "running",
          ).length,
      now: options.restart,
    },
  );

  const terminals = terminalBroker(sessions, auth, options.log);

  const siteHosts = new Set([
    ...loopback,
    ...(options.url ? [options.url.hostname] : []),
    ...(options.hostname === undefined || wildcards.has(options.hostname)
      ? []
      : [options.hostname]),
  ]);

  const previews = previewBroker({
    sessions,
    auth,
    siteHosts,
    secure: options.url?.protocol === "https:",
    log: options.log,
  });

  const server = Bun.serve<SocketData>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    idleTimeout: 30,
    development: false,
    routes: { [webPath]: web },
    fetch: async (request, bunServer) => {
      const preview = await previews.visit(request, bunServer);
      if (preview === "upgraded") {
        return undefined;
      }

      if (preview !== undefined) {
        return preview;
      }

      if (new URL(request.url).pathname === "/") {
        return fetch(new URL(webPath, bunServer.url));
      }

      if (!fromThisSite(request, siteHosts)) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }

      const upgraded =
        terminals.upgrade(request, bunServer) ??
        previews.upgrade(request, bunServer);

      if (upgraded === "upgraded") {
        return undefined;
      }

      return upgraded ?? previews.open(request) ?? handler(request);
    },
    websocket: {
      open: (ws) => {
        if (isPreview(ws)) {
          previews.websocket.open(ws);
        } else if (isTerminal(ws)) {
          terminals.websocket.open(ws);
        }
      },
      message: (ws, message) => {
        if (isPreview(ws)) {
          previews.websocket.message(ws, message);
        } else if (isTerminal(ws)) {
          terminals.websocket.message(ws, message);
        }
      },
      close: (ws, code, reason) => {
        if (isPreview(ws)) {
          previews.websocket.close(ws, code, reason);
        } else if (isTerminal(ws)) {
          terminals.websocket.close(ws, code, reason);
        }
      },
    },
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

function isPreview(
  ws: ServerWebSocket<SocketData>,
): ws is ServerWebSocket<PreviewData> {
  return ws.data.kind === "preview";
}

function isTerminal(
  ws: ServerWebSocket<SocketData>,
): ws is ServerWebSocket<TerminalData> {
  return ws.data.kind === "terminal";
}

// Bun matches routes before fetch and on every host, so the web UI can't be
// a route at "/", where a preview's own page is.
const webPath = "/__pi-cloud/web";

const loopback = ["127.0.0.1", "localhost", "[::1]"];
const wildcards = new Set(["0.0.0.0", "::", "[::]"]);

// Runners carry a token and reach the server under any name, such as Docker's
// host.docker.internal or a cluster Service's. A browser page sends an Origin.
// Pages are refused under names the server doesn't go by, so one that rebinds
// its own name to the server can't even try passwords (ADR 0033).
function fromThisSite(request: Request, hosts: ReadonlySet<string>): boolean {
  const host = request.headers.get("host") ?? "";
  const origin = request.headers.get("origin");

  const { pathname } = new URL(request.url);

  // Health checks, such as Kubernetes probes, use the pod's own address.
  if (pathname === "/healthz") {
    return true;
  }

  if (pathname.startsWith("/agent/")) {
    return origin === null;
  }

  return (
    URL.canParse(`http://${host}`) &&
    hosts.has(new URL(`http://${host}`).hostname) &&
    (origin === null || (URL.canParse(origin) && new URL(origin).host === host))
  );
}
