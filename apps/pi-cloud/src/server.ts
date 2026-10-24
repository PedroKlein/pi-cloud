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
  environmentHeader,
  type EnvironmentUpdate,
  isolations,
  providerHeader,
  type TranscriptBatch,
  type TrustAnswer,
  versionHeader,
  type WorkPoll,
  type Workspace,
  type WorkspaceRequest,
} from "@pi-cloud/protocol";
import { VERSION as piVersion } from "@earendil-works/pi-coding-agent";
import { InvalidProfile, type Profiles } from "@pi-cloud/profiles";
import type { Log } from "@pi-cloud/providers";
import {
  owner,
  type Rejection,
  type Result,
  type Sessions,
} from "@pi-cloud/sessions";
import { version as serverVersion } from "../package.json";
import type { PluginHost } from "./plugins";
import { sseResponse } from "./sse";

const rejectionStatus = {
  not_found: 404,
  stale_generation: 409,
  offline: 409,
  archived: 409,
  not_kept: 409,
  unknown_environment: 400,
  unknown_profile: 400,
  not_movable: 409,
} as const satisfies Record<Rejection, number>;

type Route = (
  request: Request,
  params: readonly string[],
) => Response | Promise<Response>;

type RouteTable = readonly (readonly [string, RegExp, Route])[];

export function createHandler(
  sessions: Sessions,
  profiles: Profiles,
  plugins: PluginHost,
  checkStore: () => void,
  log: Log,
): (request: Request) => Promise<Response> {
  const agent = (route: Route): Route => {
    return async (request, params) => {
      const version = request.headers.get(versionHeader);
      if (version !== String(protocolVersion)) {
        return Response.json(
          { error: `unsupported protocol version ${String(version)}` },
          { status: 400 },
        );
      }

      const runner = runnerOf(request);
      if (runner === undefined) {
        return Response.json({ error: "missing provider" }, { status: 400 });
      }

      const sessionId = params[0];

      const session =
        sessionId === undefined ? undefined : sessions.get(sessionId);

      // A Session that never reached a runner can still have a workspace
      // removal for any runner of its Environment.
      if (
        sessionId !== undefined &&
        session?.runner !== runner.name &&
        !(session?.runner === null && session.provider === runner.environment)
      ) {
        return notFound();
      }

      return route(request, params);
    };
  };

  const sessionAction =
    (message: string, act: (id: string) => Result<unknown>): Route =>
    (_request, [id = ""]) => {
      const result = act(id);
      if (result.ok) {
        log(message, { sessionId: id });
      }

      return reply(result, 200);
    };

  const browserRoutes: RouteTable = [
    [
      "GET",
      /^\/healthz$/,
      () => {
        try {
          checkStore();
        } catch (error) {
          return Response.json(
            { status: "unavailable", error: String(error) },
            { status: 503 },
          );
        }

        return Response.json({
          status: "ok",
          version: serverVersion,
          pi: piVersion,
        });
      },
    ],
    ["GET", /^\/api\/plugins$/, () => Response.json(plugins.names)],
    [
      "ANY",
      /^\/api\/plugins\/([^/]+)\/(.*)$/,
      async (request, [name = "", path = ""]) =>
        (await plugins.route(request, name, path)) ?? notFound(),
    ],
    [
      "GET",
      /^\/api\/environments$/,
      () => Response.json(sessions.environments()),
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
      async (request, [id = ""]) => {
        const { environment } = createFork(await readJson(request));

        const forked = sessions.fork(id, {
          ...(environment !== undefined && { environment }),
          actor: user,
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
      async (request) => {
        const created = sessions.start({
          ...createSession(await readJson(request)),
          actor: user,
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
      async (request, [id = ""]) =>
        reply(sessions.send(id, browserCommand(await readJson(request))), 202),
    ],
  ];

  const agentRoutes: RouteTable = [
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
      async (request) => {
        const runner = runnerOf(request) ?? { name: "", environment: "" };
        const poll = workPoll(await readJson(request));

        const { start, unload, remove, interrupted } = await sessions.claim(
          runner,
          poll,
          request.signal,
        );

        const fields = {
          provider: runner.name,
          environment: runner.environment,
        };

        for (const attempt of interrupted) {
          log("session interrupted", { ...fields, ...attempt });
        }

        // The environment holds secret values.
        for (const { environment: _secret, ...assignment } of start) {
          log("session assigned", { ...fields, ...assignment });
        }

        for (const attempt of unload) {
          log("session unloading", { ...fields, ...attempt });
        }

        return Response.json({ start, unload, remove });
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

        let send: (command: Command) => void = () => undefined;
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

          return attached.value;
        });
      },
    ],
  ];

  const routes: RouteTable = [
    ...browserRoutes,
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
          if (error instanceof BadRequest || error instanceof InvalidProfile) {
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

const profileRejectionStatus = {
  not_found: 404,
  default: 409,
  in_use: 409,
} as const;

function profileRoutes(profiles: Profiles, log: Log): RouteTable {
  const replied = (
    result: ReturnType<Profiles["update"] | Profiles["remove"]>,
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
      async (request) => {
        const profile = profiles.create(await readJson(request));
        log("profile created", { profileId: profile.id });

        return Response.json(profile, { status: 201 });
      },
    ],
    // A body with a url imports from a git repository, any other body is an
    // exported Profile file.
    [
      "POST",
      /^\/api\/profiles\/import$/,
      async (request) => {
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
      async (request, [id = ""]) => {
        const updated = profiles.update(id, await readJson(request));
        if (updated.ok) {
          log("profile updated", { profileId: id });
        }

        return replied(updated, 200);
      },
    ],
    [
      "DELETE",
      /^\/api\/profiles\/([^/]+)$/,
      (_request, [id = ""]) => {
        const removed = profiles.remove(id);
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
      (_request, [id = ""]) => {
        const file = profiles.exportOf(id);
        if (!file) {
          return notFound();
        }

        return new Response(JSON.stringify(file, null, 2), {
          headers: {
            "content-type": "application/json",
            "content-disposition": `attachment; filename="${fileName(file.name)}.json"`,
          },
        });
      },
    ],
  ];
}

function fileName(name: string): string {
  return name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "profile";
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

// v1 has no auth, so every browser request acts as the one owner.
const user = `user:${owner}` as const;

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

// Terminal commands come from the server's own terminal socket, never from a
// browser's POST.
function browserCommand(body: unknown): Command {
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
        actor: user,
        type: "message",
        text: text("text"),
        ...(images !== undefined && { images }),
        ...(requestId !== undefined && { requestId }),
        ...(delivery !== undefined && { delivery }),
      };
    }

    case "abort":
      return { actor: user, type: "abort" };
    case "set_model":
      return {
        actor: user,
        type: "set_model",
        model: modelOf(fields["model"]),
      };
    case "set_thinking":
      return {
        actor: user,
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
        actor: user,
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

      return { actor: user, type: "ui_columns", columns };
    }

    case "answer":
      return {
        actor: user,
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
        actor: user,
        type: "explain",
        id: text("id"),
        questionId: text("questionId"),
        value: text("value"),
        question,
      };
    }

    default:
      throw new BadRequest(
        "type must be message, abort, set_model, set_thinking, ui_columns, unqueue, answer or explain",
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

function runnerOf(
  request: Request,
): { readonly name: string; readonly environment: string } | undefined {
  const name = request.headers.get(providerHeader);
  if (name === null || name === "") {
    return undefined;
  }

  const environment = request.headers.get(environmentHeader);

  return {
    name,
    environment:
      environment === null || environment === "" ? name : environment,
  };
}

function workPoll(body: unknown): WorkPoll {
  const { running, folders, models, capacity } = fieldsOf(body);

  return {
    running: listOf("running", running, attemptOf),
    folders: listOf("folders", folders, (folder) =>
      textOf("each folder", folder),
    ),
    models: listOf("models", models, modelOf),
    ...(capacity !== undefined && { capacity: capacityOf(capacity) }),
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
