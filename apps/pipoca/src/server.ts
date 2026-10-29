import {
  type Answer,
  type Attempt,
  type Command,
  checkoutName,
  type CreateSession,
  type ImageAttachment,
  imageLimits,
  imageTypes,
  type LiveEvent,
  type LivePost,
  type ModelRef,
  type PluginInfo,
  type QuestionAnswer,
  type RemovalPost,
  type RemovalReport,
  type RepositoryCheckout,
  type Selection,
  type SessionEvent,
  type StartFailure,
  type ThinkingLevel,
  thinkingLevels,
  type ToolCall,
  protocolVersion,
  type EnvironmentUpdate,
  isolations,
  loggedStart,
  type CreateEnvironment,
  type EnvironmentKey,
  type JoinRequest,
  type TranscriptBatch,
  type TrustAnswer,
  versionHeader,
  type Work,
  type WorkPoll,
  type Workspace,
  type WorkspaceRequest,
} from "@pipoca/protocol";
import { VERSION as piVersion } from "@earendil-works/pi-coding-agent";
import { InvalidProfile, ProfileTooBig, type Profiles } from "@pipoca/profiles";
import type { Log } from "@pipoca/providers";
import type { Rejection, Result, Sessions } from "@pipoca/sessions";
import { version as serverVersion } from "../package.json";
import {
  type Agent,
  type Auth,
  type Credentials,
  InvalidCredentials,
  type McpToken,
  type User,
} from "./auth";
import { type Changes, changedBy } from "./changes";
import { mcpHandler } from "./mcp";
import type { PluginHost } from "./plugins";
import { sseResponse } from "./sse";

const rejectionStatus = {
  not_found: 404,
  stale_generation: 409,
  offline: 409,
  archived: 409,
  not_kept: 409,
  unknown_environment: 400,
  environment_exists: 409,
  unknown_profile: 400,
  not_movable: 409,
} as const satisfies Record<Rejection, number>;

type Route = (
  request: Request,
  params: readonly string[],
) => Response | Promise<Response>;

type RouteTable = readonly (readonly [string, RegExp, Route])[];

type UserActor = `user:${string}`;

// Requests a toolset tool makes as a user (ADR 0035). They never come from
// the network, so they carry no sign-in cookie.
const onBehalf = new WeakMap<Request, UserActor>();

export function onBehalfOf(actor: UserActor, request: Request): Request {
  onBehalf.set(request, actor);

  return request;
}

type AgentRoute = (
  request: Request,
  params: readonly string[],
  caller: Agent,
) => Response | Promise<Response>;

type BrowserRoute = (
  request: Request,
  params: readonly string[],
  actor: UserActor,
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
        return Response.json({ error: "unknown_token" }, { status: 401 });
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

      const actor =
        onBehalf.get(request) ??
        (user === undefined ? undefined : (`user:${user.id}` as const));

      if (actor === undefined) {
        return Response.json({ error: "signed_out" }, { status: 401 });
      }

      const response = await route(request, params, actor);
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
    async (request, params, actor) =>
      auth.userById(userIdOf(actor))?.admin === true
        ? await route(request, params, actor)
        : Response.json({ error: "admin_only" }, { status: 403 });

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
          async () => (await plugins.route(request, name, path)) ?? notFound(),
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

          return Response.json({ error: "unknown_key" }, { status: 401 });
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
          return Response.json(
            { error: "busy", sessions: busy },
            { status: 409 },
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
      () => Response.json(sessions.environments()),
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
    ...profileRoutes(
      profiles,
      (actor) => auth.userById(userIdOf(actor))?.admin === true,
      log,
    ),
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

  const agentRoutes: readonly (readonly [string, RegExp, AgentRoute])[] = [
    [
      "ANY",
      /^\/agent\/sessions\/([^/]+)\/plugins\/([^/]+)\/(.*)$/,
      async (request, [id = "", name = "", path = ""]) => {
        const session = sessions.get(id);

        const generation = Number(
          new URL(request.url).searchParams.get("generation") ?? NaN,
        );

        if (!session || !sessions.isCurrent(id, generation)) {
          return Response.json({ error: "stale_generation" }, { status: 409 });
        }

        return (
          (await plugins.route(request, name, path, {
            session,
            actor: `session:${id}`,
          })) ?? notFound()
        );
      },
    ],
    // The files of the Session's Profile, which the runner downloads when
    // its copy's hash differs (ADR 0041).
    [
      "GET",
      /^\/agent\/sessions\/([^/]+)\/profile$/,
      (_request, [id = ""]) => {
        const session = sessions.get(id);
        const files = session && sessions.profileFiles(session.profileId);

        return files ? Response.json(files) : notFound();
      },
    ],
    [
      "GET",
      /^\/agent\/sessions\/([^/]+)\/plugin-parts\/([^/]+)\/([^/]+)$/,
      (_request, [, name = "", hash = ""]) => {
        const path = plugins.sessionPart(name, hash);

        return path === undefined ? notFound() : new Response(Bun.file(path));
      },
    ],
    [
      "GET",
      /^\/agent\/sessions\/([^/]+)\/tools$/,
      (request, [id = ""]) => {
        const session = sessions.get(id);

        const generation = Number(
          new URL(request.url).searchParams.get("generation") ?? NaN,
        );

        return session && sessions.isCurrent(id, generation)
          ? Response.json(plugins.tools(session))
          : Response.json({ error: "stale_generation" }, { status: 409 });
      },
    ],
    [
      "POST",
      /^\/agent\/sessions\/([^/]+)\/tool-calls$/,
      async (request, [id = ""]) => {
        const call = toolCall(await readJson(request));
        const session = sessions.get(id);
        if (!session || !sessions.isCurrent(id, call.generation)) {
          return Response.json({ error: "stale_generation" }, { status: 409 });
        }

        plugins.call(session, call);

        return new Response(null, { status: 202 });
      },
    ],
    [
      "POST",
      /^\/agent\/work$/,
      async (request, _params, caller) => {
        const runner = { name: caller.runner, environment: caller.environment };
        const poll = workPoll(await readJson(request));

        const { start, unload, remove, interrupted } = await sessions.claim(
          runner,
          poll,
          request.signal,
        );

        // The plugin that started the runner may have revoked it during the
        // poll, and a revoked runner must not get Session tokens.
        if (auth.agentOf(request) === undefined) {
          return Response.json({ error: "unknown_token" }, { status: 401 });
        }

        const fields = {
          provider: runner.name,
          environment: runner.environment,
        };

        for (const attempt of interrupted) {
          log("session interrupted", { ...fields, ...attempt });
        }

        for (const assignment of start) {
          log("session assigned", { ...fields, ...loggedStart(assignment) });
        }

        for (const attempt of unload) {
          log("session unloading", { ...fields, ...attempt });
        }

        const work: Work = {
          start: start.map((assignment) => ({
            ...assignment,
            token: auth.sessionToken(caller, assignment.sessionId),
          })),
          unload,
          remove,
          profiles: [
            ...profiles.list().map(({ id }) => id),
            ...plugins.profileIds(),
          ],
        };

        return Response.json(work);
      },
    ],
    [
      "GET",
      /^\/agent\/sessions\/([^/]+)\/transcript$/,
      (_request, [id = ""]) =>
        Response.json({ entries: sessions.transcript(id) }),
    ],
    [
      "POST",
      /^\/agent\/sessions\/([^/]+)\/transcript$/,
      async (request, [id = ""]) => {
        const batch = transcriptBatch(await readJson(request));

        return reply(sessions.appendTranscript(id, batch), 200);
      },
    ],
    [
      "POST",
      /^\/agent\/sessions\/([^/]+)\/failed$/,
      async (request, [id = ""]) => {
        const failure = startFailure(await readJson(request));
        log("session failed to start", { sessionId: id, ...failure });

        return reply(sessions.fail(id, failure), 204);
      },
    ],
    [
      "POST",
      /^\/agent\/sessions\/([^/]+)\/trust$/,
      async (request, [id = ""]) => {
        const answer = trustAnswer(await readJson(request));
        log("repository trust answered", { sessionId: id, ...answer });

        return reply(sessions.trust(id, answer), 204);
      },
    ],
    [
      "POST",
      /^\/agent\/sessions\/([^/]+)\/workspace$/,
      async (request, [id = ""]) => {
        const report = removalPost(await readJson(request));
        log("workspace removal reported", { sessionId: id, ...report });

        return reply(sessions.reportRemoval(id, report), 204);
      },
    ],
    [
      "POST",
      /^\/agent\/sessions\/([^/]+)\/live$/,
      async (request, [id = ""]) =>
        reply(sessions.publish(id, livePost(await readJson(request))), 204),
    ],
    [
      "GET",
      /^\/agent\/sessions\/([^/]+)\/commands$/,
      (request, [id = ""]) => {
        const generation = Number(
          new URL(request.url).searchParams.get("generation") ?? NaN,
        );

        if (!Number.isSafeInteger(generation)) {
          throw new BadRequest("generation must be an integer");
        }

        // Commands held for the Session arrive while it attaches, before the
        // stream opens.
        const early: Command[] = [];

        let send = (command: Command): void => {
          early.push(command);
        };

        let end = (): void => undefined;

        const attached = sessions.attach(
          id,
          generation,
          (command) => {
            send(command);
          },
          () => {
            end();
          },
        );

        if (!attached.ok) {
          return reply(attached, 200);
        }

        return sseResponse((sendEvent, endStream) => {
          send = sendEvent;
          end = endStream;

          early.forEach((command) => {
            sendEvent(command);
          });

          return attached.value;
        });
      },
    ],
  ];

  const routes: RouteTable = [
    ...publicRoutes,
    ...browserRoutes.map(
      ([method, pattern, route]) => [method, pattern, signedIn(route)] as const,
    ),
    ...agentRoutes.map(
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
          if (
            error instanceof BadRequest ||
            error instanceof InvalidProfile ||
            error instanceof ProfileTooBig ||
            error instanceof InvalidCredentials
          ) {
            return Response.json({ error: error.message }, { status: 400 });
          }

          log("request failed", {
            method,
            path: pathname,
            error: String(error),
          });

          return Response.json({ error: "internal" }, { status: 500 });
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
          return Response.json({ error: "invalid_token" }, { status: 403 });
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
          return Response.json(
            { error: "password_login_off" },
            { status: 403 },
          );
        }

        if (user === "locked") {
          log("sign-in locked", { name: credentials.name });

          return Response.json({ error: "locked" }, { status: 429 });
        }

        if (user === "wrong") {
          log("sign-in failed", { name: credentials.name });

          return Response.json({ error: "wrong_password" }, { status: 401 });
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
    name: textOf("name", fields["name"]),
    password: textOf("password", fields["password"]),
  };
}

const profileRejectionStatus = {
  not_found: 404,
  default: 409,
  in_use: 409,
  admin_only: 403,
} as const;

// Shared Profiles are changed only by admins (ADR 0041).
function profileRoutes(
  profiles: Profiles,
  isAdmin: (actor: UserActor) => boolean,
  log: Log,
): readonly (readonly [string, RegExp, BrowserRoute])[] {
  const replied = (
    result: ReturnType<
      Profiles["create"] | Profiles["update"] | Profiles["remove"]
    >,
    status: number,
  ): Response =>
    result.ok
      ? reply(result, status)
      : Response.json(
          { error: result.reason },
          { status: profileRejectionStatus[result.reason] },
        );

  return [
    ["GET", /^\/api\/profiles$/, () => Response.json(profiles.list())],
    [
      "POST",
      /^\/api\/profiles$/,
      async (request, _params, actor) => {
        const created = profiles.create(
          await readJson(request),
          isAdmin(actor),
        );

        if (created.ok) {
          log("profile created", { profileId: created.value.id });
        }

        return replied(created, 201);
      },
    ],
    // A body with a url imports from a git repository, any other body is an
    // exported Profile file.
    [
      "POST",
      /^\/api\/profiles\/import$/,
      async (request) => {
        if (request.headers.get("content-type") === "application/gzip") {
          const name = new URL(request.url).searchParams.get("name") ?? "";

          const imported = await profiles.importArchive(
            name.trim() === "" ? "Imported" : name,
            await request.bytes(),
          );

          log("profile imported", { profileId: imported.id });

          return Response.json(imported, { status: 201 });
        }

        const body = await readJson(request);

        const { url } = (body ?? {}) as Record<string, unknown>;

        if (url !== undefined && typeof url !== "string") {
          throw new BadRequest("url must be a string");
        }

        const profile =
          url === undefined
            ? profiles.import(body)
            : await profiles.importFromGit(url);

        log("profile imported", { profileId: profile.id });

        return Response.json(profile, { status: 201 });
      },
    ],
    [
      "GET",
      /^\/api\/profiles\/([^/]+)$/,
      (_request, [id = ""]) => {
        const profile = profiles.get(id);

        return profile ? Response.json(profile) : notFound();
      },
    ],
    [
      "PUT",
      /^\/api\/profiles\/([^/]+)$/,
      async (request, [id = ""], actor) => {
        const updated = profiles.update(
          id,
          await readJson(request),
          isAdmin(actor),
        );

        if (updated.ok) {
          log("profile updated", { profileId: id });
        }

        return replied(updated, 200);
      },
    ],
    [
      "DELETE",
      /^\/api\/profiles\/([^/]+)$/,
      (_request, [id = ""], actor) => {
        const removed = profiles.remove(id, isAdmin(actor));
        if (removed.ok) {
          log("profile deleted", { profileId: id });
        }

        return replied(removed, 204);
      },
    ],
    [
      "POST",
      /^\/api\/profiles\/([^/]+)\/default$/,
      (_request, [id = ""]) => replied(profiles.makeDefault(id), 200),
    ],
    [
      "GET",
      /^\/api\/profiles\/([^/]+)\/export$/,
      async (_request, [id = ""]) => {
        const archive = await profiles.archive(id);
        if (!archive) {
          return notFound();
        }

        return new Response(archive, {
          headers: {
            "content-type": "application/gzip",
            "content-disposition": `attachment; filename="${id}.tar.gz"`,
          },
        });
      },
    ],
    // The admin's base Profile, file by file (ADR 0044).
    ["GET", /^\/api\/base\/files$/, () => Response.json(profiles.baseFiles())],
    [
      "POST",
      /^\/api\/base\/files$/,
      async (request, _params, actor) => {
        const files = uploadedFiles(await readJson(request));
        const written = profiles.writeBaseFiles(files, isAdmin(actor));
        if (written.ok) {
          log("base profile files uploaded", { files: files.size });
        }

        return replied(written, 204);
      },
    ],
    [
      "GET",
      /^\/api\/base\/files\/(.+)$/,
      (_request, [path = ""]) => {
        const file = profiles.baseFile(decodeURIComponent(path));

        return file ? new Response(file) : notFound();
      },
    ],
    [
      "PUT",
      /^\/api\/base\/files\/(.+)$/,
      async (request, [path = ""], actor) => {
        const written = profiles.writeBaseFiles(
          new Map([
            [decodeURIComponent(path), Buffer.from(await request.bytes())],
          ]),
          isAdmin(actor),
        );

        if (written.ok) {
          log("base profile file written");
        }

        return replied(written, 204);
      },
    ],
    [
      "DELETE",
      /^\/api\/base\/files\/(.+)$/,
      (_request, [path = ""], actor) => {
        const removed = profiles.deleteBaseFile(
          decodeURIComponent(path),
          isAdmin(actor),
        );

        if (removed.ok) {
          log("base profile file deleted");
        }

        return replied(removed, 204);
      },
    ],
    // A Profile's folder, file by file (ADR 0041).
    [
      "GET",
      /^\/api\/profiles\/([^/]+)\/files$/,
      (_request, [id = ""]) => {
        const files = profiles.files(id);

        return files ? Response.json(files) : notFound();
      },
    ],
    // Uploads files and folders as { files: { path: base64 } }, the way
    // runners get them.
    [
      "POST",
      /^\/api\/profiles\/([^/]+)\/files$/,
      async (request, [id = ""], actor) => {
        const decoded = uploadedFiles(await readJson(request));
        const written = profiles.writeFiles(id, decoded, isAdmin(actor));
        if (written.ok) {
          log("profile files uploaded", {
            profileId: id,
            files: decoded.size,
          });
        }

        return replied(written, 204);
      },
    ],
    [
      "GET",
      /^\/api\/profiles\/([^/]+)\/files\/(.+)$/,
      (_request, [id = "", path = ""]) => {
        const file = profiles.file(id, decodeURIComponent(path));

        return file ? new Response(file) : notFound();
      },
    ],
    [
      "PUT",
      /^\/api\/profiles\/([^/]+)\/files\/(.+)$/,
      async (request, [id = "", path = ""], actor) => {
        const written = profiles.writeFiles(
          id,
          new Map([
            [decodeURIComponent(path), Buffer.from(await request.bytes())],
          ]),
          isAdmin(actor),
        );

        if (written.ok) {
          log("profile file written", { profileId: id });
        }

        return replied(written, 204);
      },
    ],
    [
      "DELETE",
      /^\/api\/profiles\/([^/]+)\/files\/(.+)$/,
      (_request, [id = "", path = ""], actor) => {
        const removed = profiles.deleteFile(
          id,
          decodeURIComponent(path),
          isAdmin(actor),
        );

        if (removed.ok) {
          log("profile file deleted", { profileId: id });
        }

        return replied(removed, 204);
      },
    ],
  ];
}

function uploadedFiles(body: unknown): Map<string, Buffer> {
  const { files } = fieldsOf(body);
  if (
    typeof files !== "object" ||
    files === null ||
    Object.values(files).some((content) => typeof content !== "string")
  ) {
    throw new BadRequest("files must map paths to base64 contents");
  }

  return new Map(
    Object.entries(files as Record<string, string>).map(([path, content]) => [
      path,
      Buffer.from(content, "base64"),
    ]),
  );
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

function reply(result: Result<unknown>, status: number): Response {
  if (!result.ok) {
    return Response.json(
      { error: result.reason },
      { status: rejectionStatus[result.reason] },
    );
  }

  return result.value === undefined
    ? new Response(null, { status })
    : Response.json(result.value, { status });
}

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

class BadRequest extends Error {}

// What an in-place plugin's change can't do is the caller's to fix.
async function refused<T>(change: Promise<T>): Promise<T> {
  return change.catch((error: unknown) => {
    throw new BadRequest(
      error instanceof Error ? error.message : String(error),
    );
  });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BadRequest("body must be JSON");
  }
}

function thinkingOf(value: unknown, field = "thinking"): ThinkingLevel {
  const level = thinkingLevels.find((known) => known === value);
  if (level === undefined) {
    throw new BadRequest(
      `${field} must be one of ${thinkingLevels.join(", ")}`,
    );
  }

  return level;
}

function createFork(body: unknown): { readonly environment?: string } {
  const { environment } = (body ?? {}) as Record<string, unknown>;
  if (environment === undefined || environment === null) {
    return {};
  }

  if (typeof environment !== "string" || environment === "") {
    throw new BadRequest("environment must be a non-empty string");
  }

  return { environment };
}

function createSession(body: unknown): CreateSession {
  const {
    environment,
    profile,
    workspace,
    model,
    thinking,
    systemPrompt,
    firstMessage,
  } = (body ?? {}) as Record<string, unknown>;

  if (
    environment !== undefined &&
    environment !== null &&
    (typeof environment !== "string" || environment === "")
  ) {
    throw new BadRequest("environment must be a non-empty string");
  }

  if (
    profile !== undefined &&
    profile !== null &&
    (typeof profile !== "string" || profile === "")
  ) {
    throw new BadRequest("profile must be a non-empty string");
  }

  const request = {
    ...(typeof environment === "string" && { environment }),
    ...(typeof profile === "string" && { profile }),
    workspace: workspaceRequest(workspace),
    ...optionalText("systemPrompt", systemPrompt),
    ...optionalText("firstMessage", firstMessage),
    ...(thinking !== undefined &&
      thinking !== null && { thinking: thinkingOf(thinking) }),
  };

  if (model === undefined || model === null) {
    return request;
  }

  const { provider: modelProvider, id } = model as Record<string, unknown>;
  if (
    typeof modelProvider !== "string" ||
    modelProvider === "" ||
    typeof id !== "string" ||
    id === ""
  ) {
    throw new BadRequest("model must have a provider and an id");
  }

  return { ...request, model: { provider: modelProvider, id } };
}

const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A docker reference: no leading dash, so docker never reads it as a flag.
const imageName = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;
const maxVariables = 200;

// Well under Linux's limit on one environment string, so spawns don't fail.
const maxVariableBytes = 32 * 1024;

function environmentUpdate(body: unknown): EnvironmentUpdate {
  const { name, isolation, image, setupScript, variables, secrets } = (body ??
    {}) as Record<string, unknown>;

  if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
    throw new BadRequest("name must be a non-empty string");
  }

  const isolationLevel = isolations.find((known) => known === isolation);
  if (isolation !== undefined && isolationLevel === undefined) {
    throw new BadRequest(`isolation must be one of ${isolations.join(", ")}`);
  }

  if (
    image !== undefined &&
    image !== null &&
    (typeof image !== "string" || !imageName.test(image))
  ) {
    throw new BadRequest(
      "image must be an image name, such as debian:12, or null",
    );
  }

  if (setupScript !== undefined && typeof setupScript !== "string") {
    throw new BadRequest("setupScript must be a string");
  }

  return {
    ...(name !== undefined && { name: name.trim() }),
    ...(isolationLevel !== undefined && { isolation: isolationLevel }),
    ...(image !== undefined && { image }),
    ...(setupScript !== undefined && { setupScript }),
    ...(variables !== undefined && {
      variables: namedValues("variables", variables, false),
    }),
    ...(secrets !== undefined && {
      secrets: namedValues("secrets", secrets, true),
    }),
  };
}

function namedValues<Nullable extends boolean>(
  field: string,
  value: unknown,
  nullable: Nullable,
): Record<string, Nullable extends true ? string | null : string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequest(`${field} must be an object`);
  }

  const entries = Object.entries(value);
  if (entries.length > maxVariables) {
    throw new BadRequest(
      `${field} can hold at most ${String(maxVariables)} entries`,
    );
  }

  for (const [key, each] of entries) {
    if (!variableName.test(key)) {
      throw new BadRequest(`${field} has an invalid name: ${key}`);
    }

    if (nullable && each === null) {
      continue;
    }

    if (
      typeof each !== "string" ||
      each.includes("\0") ||
      Buffer.byteLength(each) > maxVariableBytes
    ) {
      throw new BadRequest(
        `${field}.${key} must be a string of at most ${String(maxVariableBytes)} bytes without NUL`,
      );
    }
  }

  return value as Record<
    string,
    Nullable extends true ? string | null : string
  >;
}

function optionalText<K extends string>(
  key: K,
  value: unknown,
): Partial<Record<K, string>> {
  if (value === undefined || value === null || value === "") {
    return {};
  }

  if (typeof value !== "string") {
    throw new BadRequest(`${key} must be a string`);
  }

  return { [key]: value } as Partial<Record<K, string>>;
}

function workspaceRequest(workspace: unknown): WorkspaceRequest {
  const { kind, path, repository, repositories, startPoint } = (workspace ??
    {}) as Record<string, unknown>;

  if (kind === "folder" && typeof path === "string" && path !== "") {
    return { kind, path };
  }

  const start = startPointOf(startPoint);

  if (kind === "worktree" && typeof path === "string" && path !== "") {
    return { kind, path, ...start };
  }

  if (kind === "clone" && typeof repository === "string" && repository !== "") {
    return { kind, repository, ...start };
  }

  if (
    kind === "repositories" &&
    Array.isArray(repositories) &&
    repositories.length > 0
  ) {
    const checkouts = repositories.map(repositoryCheckout);
    const names = checkouts.map((c) => checkoutName(c.repository));
    if (names.includes(undefined) || new Set(names).size !== names.length) {
      throw new BadRequest("repositories need different names");
    }

    return { kind, repositories: checkouts };
  }

  throw new BadRequest(
    "workspace must be a folder or worktree with a path, a clone with a repository, or repositories",
  );
}

function repositoryCheckout(checkout: unknown): RepositoryCheckout {
  const { repository, startPoint } = (checkout ?? {}) as Record<
    string,
    unknown
  >;

  if (typeof repository !== "string" || repository === "") {
    throw new BadRequest("each repository needs a URL");
  }

  return { repository, ...startPointOf(startPoint) };
}

// Terminal and preview commands come from the server's own sockets and
// previews, never from a browser's POST.
function browserCommand(body: unknown, actor: UserActor): Command {
  const fields = (
    typeof body === "object" && body !== null ? body : {}
  ) as Record<string, unknown>;

  const text = (key: string): string => {
    const value = fields[key];
    if (typeof value !== "string") {
      throw new BadRequest(`${key} must be a string`);
    }

    return value;
  };

  switch (fields["type"]) {
    case "message": {
      const { requestId, delivery } = fields;
      if (requestId !== undefined && typeof requestId !== "string") {
        throw new BadRequest("requestId must be a string");
      }

      if (
        delivery !== undefined &&
        delivery !== "steer" &&
        delivery !== "followUp"
      ) {
        throw new BadRequest('delivery must be "steer" or "followUp"');
      }

      const images =
        fields["images"] === undefined ? undefined : imagesOf(fields["images"]);

      return {
        actor,
        type: "message",
        text: text("text"),
        ...(images !== undefined && { images }),
        ...(requestId !== undefined && { requestId }),
        ...(delivery !== undefined && { delivery }),
      };
    }

    case "abort":
      return { actor, type: "abort" };
    case "set_model":
      return {
        actor,
        type: "set_model",
        model: modelOf(fields["model"]),
      };
    case "set_thinking":
      return {
        actor,
        type: "set_thinking",
        level: thinkingOf(fields["level"], "level"),
      };

    case "unqueue": {
      const { delivery, sendNow } = fields;
      if (delivery !== "steer" && delivery !== "followUp") {
        throw new BadRequest('delivery must be "steer" or "followUp"');
      }

      if (sendNow !== undefined && typeof sendNow !== "boolean") {
        throw new BadRequest("sendNow must be a boolean");
      }

      return {
        actor,
        type: "unqueue",
        delivery,
        text: text("text"),
        ...(sendNow === true && { sendNow }),
      };
    }

    case "ui_columns": {
      const { columns } = fields;
      if (
        typeof columns !== "number" ||
        !Number.isInteger(columns) ||
        columns < 1 ||
        columns > 1000
      ) {
        throw new BadRequest("columns must be a whole number from 1 to 1000");
      }

      return { actor, type: "ui_columns", columns };
    }

    case "answer":
      return {
        actor,
        type: "answer",
        id: text("id"),
        value: answerOf(fields["value"]),
      };
    case "explain": {
      const { question } = fields;
      if (question !== null && typeof question !== "string") {
        throw new BadRequest("question must be a string or null");
      }

      return {
        actor,
        type: "explain",
        id: text("id"),
        questionId: text("questionId"),
        value: text("value"),
        question,
      };
    }

    case "close_page":
      return { actor, type: "close_page", id: text("id") };
    default:
      throw new BadRequest(
        "type must be message, abort, set_model, set_thinking, ui_columns, unqueue, answer, explain or close_page",
      );
  }
}

function answerOf(value: unknown): Answer {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequest(
      "value must be a string, boolean, null or questions answer",
    );
  }

  const { answers, note } = fieldsOf(value);

  return {
    answers: listOf("answers", answers, questionAnswerOf),
    note: textOrNullOf("note", note),
  };
}

function questionAnswerOf(answer: unknown): QuestionAnswer {
  const { id, type, selections, text, value } = fieldsOf(answer);

  switch (type) {
    case "choice":
      return {
        id: textOf("id", id),
        type,
        selections: listOf("selections", selections, selectionOf),
      };
    case "text":
      return { id: textOf("id", id), type, text: textOf("text", text) };
    case "number":
      if (typeof value !== "number") {
        throw new BadRequest("value must be a number");
      }

      return { id: textOf("id", id), type, value };
    default:
      throw new BadRequest("each answer must be choice, text or number");
  }
}

function selectionOf(selection: unknown): Selection {
  const { value, label, custom, annotation } = fieldsOf(selection);
  if (typeof custom !== "boolean") {
    throw new BadRequest("custom must be a boolean");
  }

  return {
    value: textOf("value", value),
    label: textOf("label", label),
    custom,
    annotation: textOrNullOf("annotation", annotation),
  };
}

function imagesOf(value: unknown): readonly ImageAttachment[] {
  if (!Array.isArray(value) || value.length > imageLimits.count) {
    throw new BadRequest(
      `images must be a list of at most ${String(imageLimits.count)}`,
    );
  }

  return value.map((image: unknown): ImageAttachment => {
    const { mimeType, data } = (
      typeof image === "object" && image !== null ? image : {}
    ) as Record<string, unknown>;

    const type = imageTypes.find((known) => known === mimeType);
    if (type === undefined) {
      throw new BadRequest(`images must be ${imageTypes.join(", ")}`);
    }

    if (typeof data !== "string" || !base64.test(data)) {
      throw new BadRequest("image data must be base64");
    }

    if (Buffer.byteLength(data, "base64") > imageLimits.bytes) {
      throw new BadRequest(
        `each image must be at most ${String(imageLimits.bytes / 1024 / 1024)} MB`,
      );
    }

    return { mimeType: type, data };
  });
}

const base64 = /^[A-Za-z0-9+/]*={0,2}$/;

function startPointOf(startPoint: unknown): { startPoint?: string } {
  if (startPoint === undefined || startPoint === null || startPoint === "") {
    return {};
  }

  // A leading dash would reach git as an option.
  if (typeof startPoint !== "string" || startPoint.startsWith("-")) {
    throw new BadRequest("startPoint must be a branch, tag or commit");
  }

  return { startPoint };
}

function toolCall(body: unknown): ToolCall {
  const { generation, id, name, input } = fieldsOf(body);

  return {
    generation: integerOf("generation", generation),
    id: textOf("id", id),
    name: textOf("name", name),
    input,
  };
}

function unsupportedVersion(request: Request): Response | undefined {
  const version = request.headers.get(versionHeader);

  return version === String(protocolVersion)
    ? undefined
    : Response.json(
        { error: `unsupported protocol version ${String(version)}` },
        { status: 400 },
      );
}

// Runner and Environment names show in logs, container names and paths.
const agentName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function nameOf(key: string, value: unknown): string {
  const name = textOf(key, value);
  if (!agentName.test(name)) {
    throw new BadRequest(
      `${key} must be 1 to 64 letters, digits, dots, dashes or underscores`,
    );
  }

  return name;
}

function joinRequest(body: unknown): JoinRequest {
  return { name: nameOf("name", fieldsOf(body)["name"]) };
}

function createEnvironment(body: unknown): CreateEnvironment {
  return { name: nameOf("name", fieldsOf(body)["name"]) };
}

function workPoll(body: unknown): WorkPoll {
  const { running, folders, models, registeredModels, capacity, session } =
    fieldsOf(body);

  return {
    running: listOf("running", running, attemptOf),
    folders: listOf("folders", folders, (folder) =>
      textOf("each folder", folder),
    ),
    models: listOf("models", models, modelOf),
    ...(registeredModels !== undefined && {
      registeredModels: listOf("registeredModels", registeredModels, modelOf),
    }),
    ...(capacity !== undefined && { capacity: capacityOf(capacity) }),
    ...(session !== undefined && { session: textOf("session", session) }),
  };
}

function capacityOf(value: unknown): number {
  const capacity = integerOf("capacity", value);
  if (capacity < 1) {
    throw new BadRequest("capacity must be at least 1");
  }

  return capacity;
}

function attemptOf(attempt: unknown): Attempt {
  const { sessionId, generation } = fieldsOf(attempt);

  return {
    sessionId: textOf("sessionId", sessionId),
    generation: integerOf("generation", generation),
  };
}

function modelOf(model: unknown): ModelRef {
  const { provider, id } = fieldsOf(model);

  return { provider: textOf("provider", provider), id: textOf("id", id) };
}

function transcriptBatch(body: unknown): TranscriptBatch {
  const { generation, start, lines } = fieldsOf(body);
  if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 0) {
    throw new BadRequest("start must be a non-negative integer");
  }

  return {
    generation: integerOf("generation", generation),
    start,
    lines: listOf("lines", lines, (line) => textOf("each line", line)),
  };
}

function startFailure(body: unknown): StartFailure {
  const { generation, error } = fieldsOf(body);

  return {
    generation: integerOf("generation", generation),
    error: textOf("error", error),
  };
}

function trustAnswer(body: unknown): TrustAnswer {
  const { generation, trusted } = fieldsOf(body);
  if (typeof trusted !== "boolean") {
    throw new BadRequest("trusted must be true or false");
  }

  return { generation: integerOf("generation", generation), trusted };
}

function removalPost(body: unknown): RemovalPost {
  const { generation } = fieldsOf(body);

  return {
    ...removalReport(body),
    generation: integerOf("generation", generation),
  };
}

function removalReport(body: unknown): RemovalReport {
  const { outcome, restore, reason } = fieldsOf(body);

  switch (outcome) {
    case "removed":
      if (typeof fieldsOf(restore)["kind"] !== "string") {
        throw new BadRequest("restore must be a workspace with a kind");
      }

      return { outcome, restore: restore as Workspace };
    case "kept":
      return { outcome, reason: textOf("reason", reason) };
    default:
      throw new BadRequest('outcome must be "removed" or "kept"');
  }
}

function livePost(body: unknown): LivePost {
  const { generation, events } = fieldsOf(body);

  return {
    generation: integerOf("generation", generation),
    events: listOf("events", events, liveEventOf),
  };
}

// Only a status event changes the stored Session. The rest pass through to
// browsers unchecked, so events from a newer agent still reach them.
function liveEventOf(event: unknown): LiveEvent {
  const { type, status, transcriptLength } = fieldsOf(event);
  if (typeof type !== "string") {
    throw new BadRequest("each event needs a type");
  }

  if (type === "ui_action") {
    throw new BadRequest("only the server sends ui_action");
  }

  if (type === "status" && status !== "idle" && status !== "running") {
    throw new BadRequest('status must be "idle" or "running"');
  }

  if (
    type === "status" &&
    transcriptLength !== undefined &&
    integerOf("transcriptLength", transcriptLength) < 0
  ) {
    throw new BadRequest("transcriptLength must not be negative");
  }

  return event as LiveEvent;
}

function fieldsOf(value: unknown): Record<string, unknown> {
  const fields = typeof value === "object" && value !== null ? value : {};

  return fields as Record<string, unknown>;
}

function textOf(key: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new BadRequest(`${key} must be a string`);
  }

  return value;
}

function textOrNullOf(key: string, value: unknown): string | null {
  if (value !== null && typeof value !== "string") {
    throw new BadRequest(`${key} must be a string or null`);
  }

  return value;
}

function integerOf(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new BadRequest(`${key} must be an integer`);
  }

  return value;
}

function listOf<T>(
  key: string,
  value: unknown,
  item: (entry: unknown) => T,
): readonly T[] {
  if (!Array.isArray(value)) {
    throw new BadRequest(`${key} must be a list`);
  }

  return value.map((entry: unknown) => item(entry));
}

function lineAfter(lastEventId: string | null): number {
  const line = Number(lastEventId ?? "");

  return lastEventId !== null && Number.isSafeInteger(line) && line >= 0
    ? line + 1
    : 0;
}
