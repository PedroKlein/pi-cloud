import {
  type Answer,
  type Command,
  checkoutName,
  type CreateSession,
  type ImageAttachment,
  imageLimits,
  imageTypes,
  type LivePost,
  type RemovalReport,
  type RepositoryCheckout,
  type SessionEvent,
  type StartFailure,
  type ToolCall,
  protocolVersion,
  providerHeader,
  type TranscriptBatch,
  versionHeader,
  type WorkPoll,
  type WorkspaceRequest,
} from "@pi-cloud/protocol";
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
} as const satisfies Record<Rejection, number>;

type Route = (
  request: Request,
  params: readonly string[],
) => Response | Promise<Response>;

export function createHandler(
  sessions: Sessions,
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

      const provider = request.headers.get(providerHeader);
      if (provider === null || provider === "") {
        return Response.json({ error: "missing provider" }, { status: 400 });
      }

      const sessionId = params[0];
      if (
        sessionId !== undefined &&
        sessions.get(sessionId)?.provider !== provider
      ) {
        return Response.json({ error: "not_found" }, { status: 404 });
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

  const routes: readonly (readonly [string, RegExp, Route])[] = [
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

        return Response.json({ status: "ok", version: serverVersion });
      },
    ],
    ["GET", /^\/api\/plugins$/, () => Response.json(plugins.names)],
    [
      "ANY",
      /^\/api\/plugins\/([^/]+)\/(.*)$/,
      async (request, [name = "", path = ""]) =>
        (await plugins.route(request, name, path)) ??
        Response.json({ error: "not_found" }, { status: 404 }),
    ],
    [
      "ANY",
      /^\/agent\/sessions\/([^/]+)\/plugins\/([^/]+)\/(.*)$/,
      agent(async (request, [id = "", name = "", path = ""]) => {
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
          })) ?? Response.json({ error: "not_found" }, { status: 404 })
        );
      }),
    ],
    [
      "GET",
      /^\/agent\/sessions\/([^/]+)\/tools$/,
      agent((request, [id = ""]) => {
        const session = sessions.get(id);

        const generation = Number(
          new URL(request.url).searchParams.get("generation") ?? NaN,
        );

        return session && sessions.isCurrent(id, generation)
          ? Response.json(plugins.tools(session))
          : Response.json({ error: "stale_generation" }, { status: 409 });
      }),
    ],
    [
      "POST",
      /^\/agent\/sessions\/([^/]+)\/tool-calls$/,
      agent(async (request, [id = ""]) => {
        const call = await readJson<ToolCall>(request);
        const session = sessions.get(id);
        if (!session || !sessions.isCurrent(id, call.generation)) {
          return Response.json({ error: "stale_generation" }, { status: 409 });
        }

        plugins.call(session, call);

        return new Response(null, { status: 202 });
      }),
    ],
    [
      "GET",
      /^\/api\/environments$/,
      () => Response.json(sessions.environments()),
    ],
    [
      "GET",
      /^\/api\/sessions$/,
      (request) =>
        Response.json(
          sessions.list({
            archived:
              new URL(request.url).searchParams.get("archived") === "true",
          }),
        ),
    ],
    [
      "POST",
      /^\/api\/sessions$/,
      async (request) => {
        const created = sessions.start({
          ...createSession(await readJson<unknown>(request)),
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

        return session
          ? Response.json(session)
          : Response.json({ error: "not_found" }, { status: 404 });
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
        reply(
          sessions.send(id, browserCommand(await readJson<unknown>(request))),
          202,
        ),
    ],
    [
      "POST",
      /^\/agent\/work$/,
      agent(async (request) => {
        const provider = request.headers.get(providerHeader) ?? "";
        const poll = await readJson<WorkPoll>(request);

        const { start, unload, remove, interrupted } = await sessions.claim(
          provider,
          poll,
          request.signal,
        );

        for (const attempt of interrupted) {
          log("session interrupted", { provider, ...attempt });
        }

        for (const assignment of start) {
          log("session assigned", { provider, ...assignment });
        }

        for (const attempt of unload) {
          log("session unloading", { provider, ...attempt });
        }

        return Response.json({ start, unload, remove });
      }),
    ],
    [
      "POST",
      /^\/agent\/sessions\/([^/]+)\/transcript$/,
      agent(async (request, [id = ""]) => {
        const batch = await readJson<TranscriptBatch>(request);
        if (!Number.isSafeInteger(batch.start) || batch.start < 0) {
          throw new BadRequest("start must be a non-negative integer");
        }

        return reply(sessions.appendTranscript(id, batch), 200);
      }),
    ],
    [
      "POST",
      /^\/agent\/sessions\/([^/]+)\/failed$/,
      agent(async (request, [id = ""]) => {
        const failure = await readJson<StartFailure>(request);
        log("session failed to start", { sessionId: id, ...failure });

        return reply(sessions.fail(id, failure), 204);
      }),
    ],
    [
      "POST",
      /^\/agent\/sessions\/([^/]+)\/workspace$/,
      agent(async (request, [id = ""]) => {
        const report = await readJson<RemovalReport>(request);
        log("workspace removal reported", { sessionId: id, ...report });

        return reply(sessions.reportRemoval(id, report), 204);
      }),
    ],
    [
      "POST",
      /^\/agent\/sessions\/([^/]+)\/live$/,
      agent(async (request, [id = ""]) =>
        reply(sessions.publish(id, await readJson<LivePost>(request)), 204),
      ),
    ],
    [
      "GET",
      /^\/agent\/sessions\/([^/]+)\/commands$/,
      agent((request, [id = ""]) => {
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
      }),
    ],
  ];

  return async (request) => {
    const { pathname } = new URL(request.url);
    for (const [method, pattern, route] of routes) {
      const match = pattern.exec(pathname);
      if (match && (method === "ANY" || request.method === method)) {
        try {
          return await route(request, match.slice(1));
        } catch (error) {
          if (error instanceof BadRequest) {
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

    return Response.json({ error: "not_found" }, { status: 404 });
  };
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

class BadRequest extends Error {}

// v1 has no auth, so every browser request acts as the one owner.
const user = `user:${owner}` as const;

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new BadRequest("body must be JSON");
  }
}

function createSession(body: unknown): CreateSession {
  const { environment, workspace, model, systemPrompt, firstMessage } = (body ??
    {}) as Record<string, unknown>;

  if (
    environment !== undefined &&
    environment !== null &&
    (typeof environment !== "string" || environment === "")
  ) {
    throw new BadRequest("environment must be a non-empty string");
  }

  const request = {
    ...(typeof environment === "string" && { environment }),
    workspace: workspaceRequest(workspace),
    ...optionalText("systemPrompt", systemPrompt),
    ...optionalText("firstMessage", firstMessage),
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
    if (names.includes("") || new Set(names).size !== names.length) {
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
    case "unqueue": {
      const { delivery } = fields;
      if (delivery !== "steer" && delivery !== "followUp") {
        throw new BadRequest('delivery must be "steer" or "followUp"');
      }

      return { actor: user, type: "unqueue", delivery, text: text("text") };
    }

    case "answer":
      return {
        actor: user,
        type: "answer",
        id: text("id"),
        value: fields["value"] as Answer,
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
        "type must be message, abort, unqueue, answer or explain",
      );
  }
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

function lineAfter(lastEventId: string | null): number {
  const line = Number(lastEventId ?? "");

  return lastEventId !== null && Number.isSafeInteger(line) && line >= 0
    ? line + 1
    : 0;
}
