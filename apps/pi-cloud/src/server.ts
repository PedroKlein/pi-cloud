import {
  type Answer,
  type Command,
  type CreateSession,
  type LivePost,
  type RemovalReport,
  type SessionEvent,
  type StartFailure,
  protocolVersion,
  providerHeader,
  type TranscriptBatch,
  versionHeader,
  type WorkPoll,
  type WorkspaceRequest,
} from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";
import type { Rejection, Result, Sessions } from "@pi-cloud/sessions";
import { version as serverVersion } from "../package.json";
import { sseResponse } from "./sse";

const rejectionStatus = {
  not_found: 404,
  stale_generation: 409,
  offline: 409,
  archived: 409,
  not_archived: 409,
  not_kept: 409,
} as const satisfies Record<Rejection, number>;

type Route = (
  request: Request,
  params: readonly string[],
) => Response | Promise<Response>;

export function createHandler(
  sessions: Sessions,
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
    ["GET", /^\/api\/providers$/, () => Response.json(sessions.providers())],
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
        const session = sessions.create(
          createSession(await readJson<unknown>(request)),
        );

        log("session created", {
          sessionId: session.id,
          provider: session.provider,
        });

        return Response.json(session, { status: 201 });
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
      if (match && request.method === method) {
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

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new BadRequest("body must be JSON");
  }
}

function createSession(body: unknown): CreateSession {
  const { provider, workspace, model } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (typeof provider !== "string" || provider === "") {
    throw new BadRequest("provider must be a non-empty string");
  }

  const request = {
    provider,
    workspace: workspaceRequest(workspace),
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

function workspaceRequest(workspace: unknown): WorkspaceRequest {
  const { kind, path, repository, startPoint } = (workspace ?? {}) as Record<
    string,
    unknown
  >;

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

  throw new BadRequest(
    "workspace must be a folder or worktree with a path, or a clone with a repository",
  );
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

      return {
        type: "message",
        text: text("text"),
        ...(requestId !== undefined && { requestId }),
        ...(delivery !== undefined && { delivery }),
      };
    }

    case "abort":
      return { type: "abort" };
    case "answer":
      return {
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
        type: "explain",
        id: text("id"),
        questionId: text("questionId"),
        value: text("value"),
        question,
      };
    }

    default:
      throw new BadRequest("type must be message, abort, answer or explain");
  }
}

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
