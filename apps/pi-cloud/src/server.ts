import {
  type Command,
  type CreateSession,
  type LivePost,
  type SessionEvent,
  type StartFailure,
  protocolVersion,
  providerHeader,
  type TranscriptBatch,
  versionHeader,
  type WorkPoll,
} from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";
import type { Rejection, Result, Sessions } from "@pi-cloud/sessions";
import { sseResponse } from "./sse";

const rejectionStatus = {
  not_found: 404,
  stale_generation: 409,
  offline: 409,
} as const satisfies Record<Rejection, number>;

type Route = (
  request: Request,
  params: readonly string[],
) => Response | Promise<Response>;

export function createHandler(
  sessions: Sessions,
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

  const routes: readonly (readonly [string, RegExp, Route])[] = [
    ["GET", /^\/api\/sessions$/, () => Response.json(sessions.list())],
    [
      "POST",
      /^\/api\/sessions$/,
      async (request) => {
        const session = sessions.create(await readJson<CreateSession>(request));
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
      (_request, [id = ""]) => {
        let send: (event: SessionEvent) => void = () => undefined;
        const watch = sessions.watch(id, (event) => {
          send(event);
        });
        if (!watch.ok) {
          return reply(watch, 200);
        }
        return sseResponse((s) => {
          send = s;
          watch.value.replay.forEach(s);
          return watch.value.stop;
        });
      },
    ],
    [
      "POST",
      /^\/api\/sessions\/([^/]+)\/commands$/,
      async (request, [id = ""]) =>
        reply(sessions.send(id, await readJson<Command>(request)), 202),
    ],
    [
      "POST",
      /^\/agent\/work$/,
      agent(async (request) => {
        const provider = request.headers.get(providerHeader) ?? "";
        const { running } = await readJson<WorkPoll>(request);
        const start = await sessions.claim(provider, running, request.signal);
        for (const assignment of start) {
          log("session assigned", { provider, ...assignment });
        }
        return Response.json({ start });
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
        const attached = sessions.attach(id, generation, (command) => {
          send(command);
        });
        if (!attached.ok) {
          return reply(attached, 200);
        }
        return sseResponse((s) => {
          send = s;
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
