import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { gitHosts } from "@pipoca/git-hosts/server";
import { kubernetesPlugin } from "@pipoca/kubernetes/server";
import { library } from "@pipoca/library/server";
import { logins as loginsPlugin } from "@pipoca/logins/server";
import { meta } from "@pipoca/meta/server";
import { models } from "@pipoca/models/server";
import { oidc } from "@pipoca/oidc/server";
import { projects } from "@pipoca/projects/server";
import { kernelToolsets, startPlugins } from "@pipoca/pluginhost";
import { eventBus, type ServerPlugin } from "@pipoca/plugins";
import type { PluginManifest } from "@pipoca/protocol";
import type { Log } from "@pipoca/providers";
import { ProfileFolders, Profiles } from "@pipoca/profiles";
import { Sessions, type SessionsOptions } from "@pipoca/sessions";
import web from "@pipoca/web/index.html";
import { type AgentOptions, runAgent } from "./agent";
import { Auth } from "./auth";
import { configFolder } from "./config";
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
import { builtInPlugins, sessionPlugins } from "./session-parts";
import { errorReply } from "./replies";
import { previewBroker } from "./previews";
import { changeFeed } from "./changes";
import { createHandler, fromAddress, onBehalfOf } from "./server";
import type { PreviewData, SocketData, TerminalData } from "./sockets";
import { openStore } from "./store";
import { terminalBroker } from "./terminals";

const serverPlugins: readonly ServerPlugin[] = [
  projects,
  library,
  models,
  kubernetesPlugin,
  meta,
  oidc,
  gitHosts,
  loginsPlugin,
];

export interface ServeOptions {
  // 127.0.0.1 unless a proxy or other machines reach the server directly.
  readonly hostname?: string;
  readonly port: number;
  // Where people open the server, for the setup link, when that isn't where
  // it listens, such as behind a gateway.
  readonly url?: URL;
  readonly database: string;
  // Holds pipoca.json and the plugins' own config files (ADR 0039); a
  // config folder next to the database when unset.
  readonly configDir?: string;
  // Encrypts Environment secrets; a file next to the database when unset.
  readonly secretKey?: Buffer;
  // False leaves only the setup link and plugin logins, such as OIDC.
  readonly passwordLogin?: boolean;
  // Takes a client's address from the X-Forwarded-For entry the proxy in
  // front added. Only behind one, since without it anyone can send that
  // header and pick the address their failed sign-ins count against.
  readonly trustProxy?: boolean;
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
  // Seconds a connection may go quiet before the server closes it; 30 when
  // unset.
  readonly idleTimeout?: number;
  // The clock runner tokens expire by; the system's when unset.
  readonly now?: () => number;
  readonly log: Log;
}

// Installing, updating or building a plugin, or importing a Profile from
// git, can take minutes with nothing sent until it is done.
const longRoutes = [
  ["POST", /^\/api\/plugins$/],
  ["PATCH", /^\/api\/plugins\/[^/]+$/],
  ["POST", /^\/api\/plugin-builds\/[^/]+$/],
  ["POST", /^\/api\/profiles\/import$/],
] as const;

function takesLong(request: Request): boolean {
  const { pathname } = new URL(request.url);

  return longRoutes.some(
    ([method, path]) => request.method === method && path.test(pathname),
  );
}

export function serve(options: ServeOptions): {
  readonly url: URL;
  readonly stop: () => Promise<void>;
} {
  // A server on an in-memory database keeps nothing, its config included.
  const configDir =
    options.configDir ??
    (options.database === ":memory:"
      ? mkdtempSync(join(tmpdir(), "pipoca-config-"))
      : join(dirname(options.database), "config"));

  const config = configFolder(configDir, options.log);

  const profiles = new ProfileFolders(
    join(configDir, "profiles"),
    options.log,
    join(configDir, "base"),
  );

  const store = openStore(options.database, options.secretKey, profiles);
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

  // A Session on the server's own runner would share the server pod's files,
  // its sealing key among them, so a server that can start runner pods runs
  // no runner itself (ADR 0049). The chart names the runners' URL only when
  // it lets the server start them.
  const startsPods =
    enabled.includes("kubernetes") &&
    process.env["KUBERNETES_SERVICE_HOST"] !== undefined &&
    process.env["PIPOCA_RUNNER_URL"] !== undefined;

  const ownAgent = startsPods ? undefined : options.agent;

  if (options.agent !== undefined && ownAgent === undefined) {
    options.log(
      "the server's own runner is off, since it starts runner pods in its cluster",
      { runner: options.agent.provider },
    );
  }

  const events = eventBus((type, error) => {
    options.log("event listener failed", { type, error: String(error) });
  });

  const changes = changeFeed();

  const sessions = new Sessions(store, {
    ...options.sessions,
    events: events.publish,
    changed: () => {
      changes.publish("sessions");
    },
    runnersChanged: () => {
      changes.publish("environments");
    },
    sessionPlugins: () => pluginHost.sessionPlugins(),
    offeredModels: (environmentId, userId) =>
      pluginHost.offeredModels(environmentId, userId),
    startsRunners: (environmentId) => pluginHost.startsRunners(environmentId),
    pluginProfile: (id) => pluginHost.profile(id),
    gitLogins: (userId) => pluginHost.gitLogins(userId),
  });

  const pluginsStop = new AbortController();
  const auth = new Auth(store.auth, options.passwordLogin, options.now);

  const userProfiles = new Profiles(profiles, store);

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
    changes: changes.publish,
    store: store.plugin,
    settings: store.pluginSettings,
    config,
    toolsets: kernelToolsets,
    api: async (onBehalf, request) => handler(onBehalfOf(onBehalf, request)),
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
    sessionParts: sessionPlugins,
    mcpServers: () => userProfiles.mcpServers(),
    signal: pluginsStop.signal,
    log: options.log,
  });

  const handler = createHandler(
    auth,
    sessions,
    userProfiles,
    pluginHost,
    changes,
    store.check,
    options.log,
    options.restart && {
      busy: () =>
        sessions
          .list()
          .filter(
            ({ provider, runner, status }) =>
              provider === ownAgent?.provider &&
              runner === ownAgent.provider &&
              (status === "starting" || status === "running"),
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
    idleTimeout: options.idleTimeout ?? 30,
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
        return errorReply(
          403,
          "forbidden",
          "Requests from another site aren't allowed.",
        );
      }

      const upgraded =
        terminals.upgrade(request, bunServer) ??
        previews.upgrade(request, bunServer);

      if (upgraded === "upgraded") {
        return undefined;
      }

      if (takesLong(request)) {
        bunServer.timeout(request, 0);
      }

      return (
        upgraded ??
        previews.open(request) ??
        handler(
          fromAddress(
            clientAddress(request, bunServer, options.trustProxy === true),
            request,
          ),
        )
      );
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
  const ownRunner = ownAgent?.provider;
  if (ownRunner !== undefined) {
    store.ensureEnvironment(ownRunner);
  }

  const agent =
    ownAgent &&
    runAgent({
      ...ownAgent,
      server: server.url.href,
      credential: {
        token: auth.ownRunnerToken(ownAgent.provider, ownAgent.provider),
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

// A proxy adds the address it saw to the end of the header, after whatever
// the client sent.
function clientAddress(
  request: Request,
  server: Bun.Server<SocketData>,
  trustProxy: boolean,
): string {
  const forwarded = trustProxy
    ? request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
    : undefined;

  if (forwarded !== undefined && forwarded !== "") {
    return forwarded;
  }

  return server.requestIP(request)?.address ?? "";
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
const webPath = "/__pipoca/web";

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
