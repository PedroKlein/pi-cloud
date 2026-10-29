import {
  type PluginInfo,
  type SessionEvent,
  protocolVersion,
  type EnvironmentKey,
  versionHeader,
} from "@pipoca/protocol";
import { VERSION as piVersion } from "@earendil-works/pi-coding-agent";
import {
  BadRequest,
  fieldsOf,
  HttpError,
  isHttpError,
  NotFound,
  readJson,
} from "@pipoca/plugins";
import { InvalidProfile, ProfileTooBig, type Profiles } from "@pipoca/profiles";
import type { Log } from "@pipoca/providers";
import type { Result, Sessions } from "@pipoca/sessions";
import { version as serverVersion } from "../package.json";
import {
  type Auth,
  type Credentials,
  InvalidCredentials,
  type McpToken,
  type User,
} from "./auth";
import { type Changes, changedBy } from "./changes";
import { mcpHandler } from "./mcp";
import type { OnBehalf, PluginHost, UserActor } from "./plugins";
import { type AgentRoute, agentRoutes } from "./agent-routes";
import { profileRoutes } from "./profile-routes";
import { errorReply, notFound, reply } from "./replies";
import {
  browserCommand,
  createEnvironment,
  createFork,
  createSession,
  environmentUpdate,
  joinRequest,
  lineAfter,
  listOf,
  textOf,
} from "./requests";
import { sseResponse } from "./sse";

type Route = (
  request: Request,
  params: readonly string[],
) => Response | Promise<Response>;

type RouteTable = readonly (readonly [string, RegExp, Route])[];

// Requests a toolset tool makes as a user (ADR 0035). They never come from
// the network, so they carry no sign-in cookie.
const onBehalf = new WeakMap<Request, OnBehalf>();

export function onBehalfOf(caller: OnBehalf, request: Request): Request {
  onBehalf.set(request, caller);

  return request;
}

export type BrowserRoute = (
  request: Request,
  params: readonly string[],
  actor: UserActor,
  admin: boolean,
) => Response | Promise<Response>;

// Tells one run of the server from the next, so a page waiting out a restart
// knows when the new one answers.
const started = new Date().toISOString();

export interface ServerRestart {
  // Sessions on the server's own runner that are mid-turn.
  readonly busy: () => number;
  readonly now: () => void;
}

export function createHandler(
  auth: Auth,
  sessions: Sessions,
  profiles: Profiles,
  plugins: PluginHost,
  changes: Changes,
  checkStore: () => void,
  log: Log,
  restart?: ServerRestart,
): (request: Request) => Promise<Response> {
  const agent = (route: AgentRoute): Route => {
    return async (request, params) => {
      const unsupported = unsupportedVersion(request);
      if (unsupported) {
        return unsupported;
      }

      const caller = auth.agentOf(request);
      if (caller === undefined) {
        return errorReply(
          401,
          "unknown_token",
          "The server doesn't know this token.",
        );
      }

      const sessionId = params[0];

      if (sessionId === undefined) {
        return caller.sessionId === null
          ? await route(request, params, caller)
          : notFound();
      }

      const session = sessions.get(sessionId);

      // A Session that never reached a runner can still have a workspace
      // removal for any runner of its Environment.
      // Runner names are unique only within an Environment.
      if (
        (caller.sessionId !== null && caller.sessionId !== sessionId) ||
        session?.provider !== caller.environment ||
        (session.runner !== null && session.runner !== caller.runner)
      ) {
        return notFound();
      }

      return await route(request, params, caller);
    };
  };

  const signedIn = (route: BrowserRoute): Route => {
    return async (request, params) => {
      const user = auth.userOf(request);
      const behalf = onBehalf.get(request);

      const actor =
        behalf?.actor ??
        (user === undefined ? undefined : (`user:${user.id}` as const));

      if (actor === undefined) {
        return errorReply(401, "signed_out", "Sign in again.");
      }

      const admin =
        behalf?.mayAdmin !== false &&
        auth.userById(userIdOf(actor))?.admin === true;

      const response = await route(request, params, actor, admin);
      const topic = changedBy(request, response);
      if (topic !== undefined) {
        changes.publish(topic);
      }

      return response;
    };
  };

  // Plugins run code inside the server, so only admins change them.
  const admin =
    (route: BrowserRoute): BrowserRoute =>
    async (request, params, actor, isAdmin) =>
      isAdmin
        ? await route(request, params, actor, isAdmin)
        : errorReply(
            403,
            "admin_only",
            "Only admins change plugins and restart the server.",
          );

  const sessionAction =
    (message: string, act: (id: string) => Result<unknown>): Route =>
    (_request, [id = ""]) => {
      const result = act(id);
      if (result.ok) {
        log(message, { sessionId: id });
      }

      return reply(result, 200);
    };

  // A runner that joins with a join key gets an Environment of its own name,
  // numbered when another Environment has it.
  const environmentFor = (runner: string): string => {
    const taken = new Set(
      sessions.environments().map(({ provider }) => provider),
    );

    let provider = runner;
    for (let n = 2; taken.has(provider); n++) {
      provider = `${runner.slice(0, 60)}-${String(n)}`;
    }

    const created = sessions.createEnvironment(provider);
    if (!created.ok) {
      throw new Error(`environment ${provider} was not made`);
    }

    log("environment created", { environmentId: created.value.id, runner });
    changes.publish("environments");

    return provider;
  };

  const publicRoutes: RouteTable = [
    [
      "GET",
      /^\/healthz$/,
      () => {
        try {
          checkStore();
        } catch (error) {
          log("database unavailable", { error: String(error) });

          return Response.json({ status: "unavailable" }, { status: 503 });
        }

        return Response.json({
          status: "ok",
          version: serverVersion,
          pi: piVersion,
          started,
        });
      },
    ],
    ...authRoutes(auth, plugins, log),
    [
      "ANY",
      /^\/api\/plugins\/([^/]+)\/(.*)$/,
      async (request, [name = "", path = ""]) =>
        (await plugins.publicRoute(request, name, path)) ??
        signedIn(
          async (_request, _params, actor, isAdmin) =>
            (await plugins.route(request, name, path, {
              kind: "user",
              actor,
              admin: isAdmin,
            })) ?? notFound(),
        )(request, [name, path]),
    ],
    ["ANY", /^\/api\/mcp$/, mcpHandler(auth, plugins, serverVersion, log)],
    [
      "POST",
      /^\/agent\/join$/,
      async (request) => {
        const unsupported = unsupportedVersion(request);
        if (unsupported) {
          return unsupported;
        }

        const [scheme, key] = (
          request.headers.get("authorization") ?? ""
        ).split(" ");

        const { name } = joinRequest(await readJson(request));

        const joined =
          scheme === "Bearer" && key !== undefined
            ? auth.join(key, name, environmentFor)
            : undefined;

        if (joined === undefined) {
          log("runner refused", { runner: name });

          return errorReply(
            401,
            "unknown_key",
            "The server doesn't know this join key.",
          );
        }

        log("runner joined", { runner: name, environment: joined.environment });

        return Response.json(joined);
      },
    ],
  ];

  const browserRoutes: readonly (readonly [string, RegExp, BrowserRoute])[] = [
    ["GET", /^\/api\/changes$/, () => changes.stream()],
    ["GET", /^\/api\/plugins$/, () => Response.json(plugins.list())],
    [
      "POST",
      /^\/api\/plugins$/,
      admin(async (request) => {
        const { url } = fieldsOf(await readJson(request));
        const installed = await plugins.install(textOf("url", url));

        if (typeof installed === "string") {
          throw new BadRequest(installed);
        }

        return Response.json(installed, { status: 201 });
      }),
    ],
    [
      "GET",
      /^\/api\/plugin-files\/([^/]+)$/,
      async (request, [name = ""]) => {
        const path = new URL(request.url).searchParams.get("path");

        return Response.json(
          path === null
            ? await refused(plugins.files.list(name))
            : { path, content: await refused(plugins.files.read(name, path)) },
        );
      },
    ],
    [
      "PUT",
      /^\/api\/plugin-files\/([^/]+)$/,
      async (request, [name = ""]) => {
        const { path, content } = fieldsOf(await readJson(request));

        if (typeof content !== "string") {
          throw new BadRequest("content must be text");
        }

        return Response.json(
          await refused(
            plugins.files.write(name, textOf("path", path), content),
          ),
        );
      },
    ],
    [
      "POST",
      /^\/api\/plugin-builds\/([^/]+)$/,
      async (_request, [name = ""]) =>
        Response.json(await refused(plugins.files.build(name))),
    ],
    [
      "DELETE",
      /^\/api\/plugins\/([^/]+)$/,
      admin(async (_request, [name = ""]) => {
        const removed = await plugins.remove(name);

        if (typeof removed === "string") {
          throw new BadRequest(removed);
        }

        return removed ? new Response(null, { status: 204 }) : notFound();
      }),
    ],
    [
      "POST",
      /^\/api\/restart$/,
      admin(async (request) => {
        if (restart === undefined) {
          throw new BadRequest(
            "nothing starts this server again when it stops, so restart it yourself",
          );
        }

        const { force } = fieldsOf(await readJson(request));
        const busy = restart.busy();

        // Sessions on the server's own runner stop with it mid-turn
        // (ADR 0022), so the user decides.
        if (busy > 0 && force !== true) {
          return errorReply(
            409,
            "busy",
            "Sessions are mid-turn on the server's own runner.",
            { sessions: busy },
          );
        }

        log("server restarting", { interrupted: busy });

        // After the answer is on its way.
        setTimeout(restart.now, 100);

        return new Response(null, { status: 202 });
      }),
    ],
    [
      "GET",
      /^\/api\/plugin-parts\/([^/]+)\/([^/]+)$/,
      (_request, [name = "", file = ""]) => {
        const path = plugins.webPart(name, file);

        // Named by content hash, so a browser can keep it.
        return path === undefined
          ? notFound()
          : new Response(Bun.file(path), {
              headers: {
                "content-type": "text/javascript; charset=utf-8",
                "cache-control": "private, max-age=31536000, immutable",
              },
            });
      },
    ],
    [
      "GET",
      /^\/api\/pinned-pages$/,
      (_request, _params, actor) =>
        Response.json({ pages: auth.pinnedPages(userIdOf(actor)) }),
    ],
    [
      "PUT",
      /^\/api\/pinned-pages$/,
      async (request, _params, actor) => {
        const { pages } = fieldsOf(await readJson(request));

        auth.pinPages(
          userIdOf(actor),
          listOf("pages", pages, (page) => textOf("page", page)),
        );

        return new Response(null, { status: 204 });
      },
    ],
    [
      "GET",
      /^\/api\/mcp-tokens$/,
      (_request, _params, actor) =>
        Response.json(auth.mcpTokens(userIdOf(actor)).map(mcpTokenView)),
    ],
    [
      "POST",
      /^\/api\/mcp-tokens$/,
      async (request, _params, actor) => {
        const { name } = fieldsOf(await readJson(request));

        const { token, secret } = auth.newMcpToken(
          userIdOf(actor),
          textOf("name", name),
        );

        log("mcp token created", { tokenId: token.id });

        return Response.json(
          { token: mcpTokenView(token), secret },
          { status: 201 },
        );
      },
    ],
    [
      "DELETE",
      /^\/api\/mcp-tokens\/([^/]+)$/,
      (_request, [id = ""], actor) => {
        if (!auth.revokeMcpToken(userIdOf(actor), id)) {
          return notFound();
        }

        log("mcp token revoked", { tokenId: id });

        return new Response(null, { status: 204 });
      },
    ],
    [
      "PATCH",
      /^\/api\/plugins\/([^/]+)$/,
      admin(async (request, [name = ""]) => {
        const { settings, enabled, update, digest } = fieldsOf(
          await readJson(request),
        );

        if (enabled !== undefined && typeof enabled !== "boolean") {
          throw new BadRequest("enabled must be true or false");
        }

        const saved = await pluginChange(plugins, name, {
          settings,
          enabled,
          update: update === true,
          ...(typeof digest === "string" && { digest }),
        });

        if (typeof saved === "string") {
          throw new BadRequest(saved);
        }

        return saved === undefined ? notFound() : Response.json(saved);
      }),
    ],
    [
      "GET",
      /^\/api\/environments$/,
      (_request, _params, actor) =>
        Response.json(sessions.environments(userIdOf(actor))),
    ],
    [
      "POST",
      /^\/api\/environments$/,
      async (request) => {
        const { name } = createEnvironment(await readJson(request));
        const created = sessions.createEnvironment(name);
        if (!created.ok) {
          return reply(created, 201);
        }

        const key = auth.newEnvironmentKey(created.value.provider);
        log("environment created", { environmentId: created.value.id });

        return Response.json(
          { environment: { ...created.value, hasKey: true }, key },
          { status: 201 },
        );
      },
    ],
    [
      "POST",
      /^\/api\/join-key$/,
      () => {
        log("join key made", {});

        return Response.json({ key: auth.newJoinKey() }, { status: 201 });
      },
    ],
    [
      "POST",
      /^\/api\/environments\/([^/]+)\/key$/,
      (_request, [id = ""]) => {
        const environment = sessions
          .environments()
          .find((each) => each.id === id);

        if (!environment) {
          return notFound();
        }

        const key: EnvironmentKey = {
          key: auth.newEnvironmentKey(environment.provider),
        };

        log("environment key replaced", { environmentId: id });

        return Response.json(key);
      },
    ],
    [
      "PATCH",
      /^\/api\/environments\/([^/]+)$/,
      async (request, [id = ""]) => {
        const updated = sessions.updateEnvironment(
          id,
          environmentUpdate(await readJson(request)),
        );

        if (!updated.ok) {
          return notFound();
        }

        log("environment updated", { environmentId: id });

        return Response.json(updated.value);
      },
    ],
    ...profileRoutes(profiles, log),
    [
      "GET",
      /^\/api\/sessions$/,
      (request) => {
        const query = new URL(request.url).searchParams;

        const all = sessions.list({
          archived: query.get("archived") === "true",
        });

        // An owned Session shows only inside its plugin, unless that plugin
        // is off (ADR 0028). owner=all is for search and notices.
        return Response.json(
          query.get("owner") === "all"
            ? all
            : all.filter(
                (session) =>
                  session.owner === null ||
                  !plugins.names.includes(session.owner.plugin),
              ),
        );
      },
    ],
    [
      "POST",
      /^\/api\/sessions\/([^/]+)\/fork$/,
      async (request, [id = ""], actor) => {
        const { environment } = createFork(await readJson(request));

        const forked = sessions.fork(id, {
          ...(environment !== undefined && { environment }),
          actor,
        });

        if (forked.ok) {
          log("session forked", {
            sessionId: forked.value.id,
            from: id,
            environmentId: forked.value.environmentId,
          });
        }

        return reply(forked, 201);
      },
    ],
    [
      "POST",
      /^\/api\/sessions$/,
      async (request, _params, actor) => {
        const created = sessions.start({
          ...createSession(await readJson(request)),
          actor,
        });

        if (created.ok) {
          log("session created", {
            sessionId: created.value.id,
            environmentId: created.value.environmentId,
            provider: created.value.provider,
          });
        }

        return reply(created, 201);
      },
    ],
    [
      "GET",
      /^\/api\/sessions\/([^/]+)$/,
      (_request, [id = ""]) => {
        const session = sessions.get(id);

        return session ? Response.json(session) : notFound();
      },
    ],
    [
      "GET",
      /^\/api\/sessions\/([^/]+)\/events$/,
      (request, [id = ""]) => {
        let send: (event: SessionEvent) => void = () => undefined;

        const watch = sessions.watch(
          id,
          (event) => {
            send(event);
          },
          lineAfter(request.headers.get("last-event-id")),
        );

        if (!watch.ok) {
          return reply(watch, 200);
        }

        return sseResponse((s) => {
          send = (event) => {
            s(event, event.type === "entry" ? String(event.line) : undefined);
          };

          watch.value.replay.forEach(send);

          return watch.value.stop;
        });
      },
    ],
    [
      "POST",
      /^\/api\/sessions\/([^/]+)\/archive$/,
      sessionAction("session archived", (id) => sessions.archive(id)),
    ],
    [
      "POST",
      /^\/api\/sessions\/([^/]+)\/unarchive$/,
      sessionAction("session unarchived", (id) => sessions.unarchive(id)),
    ],
    [
      "POST",
      /^\/api\/sessions\/([^/]+)\/remove-workspace$/,
      sessionAction("workspace removal forced", (id) =>
        sessions.forceRemoval(id),
      ),
    ],
    [
      "POST",
      /^\/api\/sessions\/([^/]+)\/commands$/,
      async (request, [id = ""], actor) =>
        reply(
          sessions.send(id, browserCommand(await readJson(request), actor)),
          202,
        ),
    ],
  ];

  const routes: RouteTable = [
    ...publicRoutes,
    ...browserRoutes.map(
      ([method, pattern, route]) => [method, pattern, signedIn(route)] as const,
    ),
    ...agentRoutes(auth, sessions, profiles, plugins, log).map(
      ([method, pattern, route]) => [method, pattern, agent(route)] as const,
    ),
  ];

  return async (request) => {
    const { pathname } = new URL(request.url);
    for (const [method, pattern, route] of routes) {
      const match = pattern.exec(pathname);
      if (match && (method === "ANY" || request.method === method)) {
        try {
          return await route(request, match.slice(1));
        } catch (error) {
          if (isHttpError(error)) {
            // A plugin that bundles an SDK from before codes throws none
            // (ADR 0046), so its status gives one.
            const { status, code, message } = new HttpError(
              error.status,
              error.message,
              (error as Partial<HttpError>).code,
            );

            return errorReply(status, code, message);
          }

          if (
            error instanceof InvalidProfile ||
            error instanceof ProfileTooBig ||
            error instanceof InvalidCredentials
          ) {
            return errorReply(400, "bad_request", error.message);
          }

          log("request failed", {
            method,
            path: pathname,
            error: String(error),
          });

          return errorReply(
            500,
            "internal",
            "The server failed to answer. Its log says why.",
          );
        }
      }
    }

    return notFound();
  };
}

function authRoutes(auth: Auth, plugins: PluginHost, log: Log): RouteTable {
  return [
    [
      "GET",
      /^\/api\/auth$/,
      (request) =>
        Response.json({ ...auth.status(request), logins: plugins.logins() }),
    ],
    [
      "POST",
      /^\/api\/auth\/setup$/,
      async (request) => {
        const fields = fieldsOf(await readJson(request));

        const user = await auth.setUp(
          textOf("token", fields["token"]),
          credentialsOf(fields),
        );

        if (user === undefined) {
          return errorReply(
            403,
            "invalid_token",
            "This setup link is not the server's current one. Open the link from its latest log.",
          );
        }

        log("first user created", { userId: user.id });

        return signedInAs(auth, user, request, 201);
      },
    ],
    [
      "POST",
      /^\/api\/auth\/login$/,
      async (request) => {
        const credentials = credentialsOf(fieldsOf(await readJson(request)));
        const user = await auth.signIn(credentials);

        if (user === "off") {
          return errorReply(
            403,
            "password_login_off",
            "This server doesn't sign people in with a password.",
          );
        }

        if (user === "locked") {
          log("sign-in locked", { name: credentials.name });

          return errorReply(
            429,
            "locked",
            "Too many failed sign-ins. Try again in 15 minutes.",
          );
        }

        if (user === "wrong") {
          log("sign-in failed", { name: credentials.name });

          return errorReply(401, "wrong_password", "Wrong name or password.");
        }

        log("signed in", { userId: user.id });

        return signedInAs(auth, user, request, 200);
      },
    ],
    [
      "POST",
      /^\/api\/auth\/logout$/,
      (request) =>
        new Response(null, {
          status: 204,
          headers: { "set-cookie": auth.endSession(request) },
        }),
    ],
  ];
}

function signedInAs(
  auth: Auth,
  user: User,
  request: Request,
  status: number,
): Response {
  return Response.json(user, {
    status,
    headers: { "set-cookie": auth.startSession(user, request) },
  });
}

function credentialsOf(fields: Record<string, unknown>): Credentials {
  return {
    name: textOf("name", fields["name"]).trim(),
    password: textOf("password", fields["password"]),
  };
}

async function pluginChange(
  plugins: PluginHost,
  name: string,
  change: {
    readonly settings: unknown;
    readonly enabled: boolean | undefined;
    readonly update: boolean;
    readonly digest?: string;
  },
): Promise<PluginInfo | string | undefined> {
  if (change.update) {
    return plugins.update(name);
  }

  return change.enabled === undefined
    ? plugins.saveSettings(name, change.settings)
    : plugins.turnOn(name, change.enabled, change.digest);
}

function userIdOf(actor: UserActor): string {
  return actor.slice("user:".length);
}

function mcpTokenView({
  id,
  name,
  createdAt,
}: McpToken): Omit<McpToken, "userId"> {
  return { id, name, createdAt };
}

// What an in-place plugin's change can't do is the caller's to fix.
async function refused<T>(change: Promise<T>): Promise<T> {
  return change.catch((error: unknown) => {
    if (error instanceof NotFound) {
      throw error;
    }

    throw new BadRequest(
      error instanceof Error ? error.message : String(error),
    );
  });
}

function unsupportedVersion(request: Request): Response | undefined {
  const version = request.headers.get(versionHeader);

  return version === String(protocolVersion)
    ? undefined
    : errorReply(
        400,
        "unsupported_version",
        `unsupported protocol version ${String(version)}`,
      );
}
