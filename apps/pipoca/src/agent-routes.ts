import { type Command, loggedStart, type Work } from "@pipoca/protocol";
import { BadRequest, readJson } from "@pipoca/plugins";
import type { Profiles } from "@pipoca/profiles";
import type { Log } from "@pipoca/providers";
import type { Sessions } from "@pipoca/sessions";
import type { Agent, Auth } from "./auth";
import type { PluginHost } from "./plugins";
import { errorReply, notFound, rejected, reply } from "./replies";
import {
  livePost,
  removalPost,
  startFailure,
  toolCall,
  transcriptBatch,
  trustAnswer,
  workPoll,
} from "./requests";
import { sseResponse } from "./sse";

export type AgentRoute = (
  request: Request,
  params: readonly string[],
  caller: Agent,
) => Response | Promise<Response>;

export function agentRoutes(
  auth: Auth,
  sessions: Sessions,
  profiles: Profiles,
  plugins: PluginHost,
  log: Log,
): readonly (readonly [string, RegExp, AgentRoute])[] {
  return [
    [
      "ANY",
      /^\/agent\/sessions\/([^/]+)\/plugins\/([^/]+)\/(.*)$/,
      async (request, [id = "", name = "", path = ""]) => {
        const session = sessions.get(id);

        const generation = Number(
          new URL(request.url).searchParams.get("generation") ?? NaN,
        );

        if (!session || !sessions.isCurrent(id, generation)) {
          return rejected("stale_generation");
        }

        return (
          (await plugins.route(request, name, path, {
            kind: "session",
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
          : rejected("stale_generation");
      },
    ],
    [
      "POST",
      /^\/agent\/sessions\/([^/]+)\/tool-calls$/,
      async (request, [id = ""]) => {
        const call = toolCall(await readJson(request));
        const session = sessions.get(id);
        if (!session || !sessions.isCurrent(id, call.generation)) {
          return rejected("stale_generation");
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
          return errorReply(
            401,
            "unknown_token",
            "The server doesn't know this token.",
          );
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
          profiles: [...profiles.ids(), ...plugins.profileIds()],
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
}
