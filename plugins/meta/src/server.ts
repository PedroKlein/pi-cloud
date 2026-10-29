import {
  BadRequest,
  NotFound,
  readBody,
  type ServerPlugin,
  type ServerPluginContext,
  type Static,
  Type,
} from "@pipoca/plugins";
import type { Actor, Session } from "@pipoca/protocol";
import { metaPrompt } from "./prompt";

const newMetaSession = Type.Object({
  text: Type.String(),
  model: Type.Optional(
    Type.Union([
      Type.Object({
        provider: Type.String({ minLength: 1 }),
        id: Type.String({ minLength: 1 }),
      }),
      Type.Null(),
    ]),
  ),
});

// Meta-sessions change Pipoca itself (ADR 0035). They run on the meta
// Profile and stay out of the Session list.
export const meta: ServerPlugin = {
  name: "meta",
  register: (context) => {
    // Other Session parts would add tools the confirm can't see into, such
    // as subagents, whose own sessions don't load it.
    context.sessions.loadOnly(["ask", "models", "meta"]);

    context.toolsets.loadInOwnSessions();

    const profile = context.profiles.provide("assistant", {
      name: "Pipoca assistant",
      packages: [],
      agentsMd: "",
      systemMd: "",
      appendSystemMd: metaPrompt,
      mcpServers: {},
      // Its workspace is empty, and these would reach the runner's machine.
      settings: { defaultTools: ["-read", "-bash", "-edit", "-write"] },
    });

    context.routes.handle(async (request, path, caller) => {
      if (path !== "sessions" || caller.kind !== "user") {
        throw new NotFound(`no route ${path}`);
      }

      if (request.method === "GET") {
        return Response.json(
          context.sessions
            .owned(context.owner)
            .filter(
              ({ startedBy }) => caller.actor === `user:${startedBy ?? ""}`,
            ),
        );
      }

      if (request.method !== "POST") {
        throw new NotFound(`no route ${path}`);
      }

      return Response.json(
        start(
          context,
          caller.actor,
          profile,
          await readBody(request, newMetaSession),
        ),
        { status: 201 },
      );
    });
  },
};

function start(
  context: ServerPluginContext,
  user: Actor,
  profile: string,
  { text, model }: Static<typeof newMetaSession>,
): Session {
  if (text.trim() === "") {
    throw new BadRequest("text must not be empty");
  }

  try {
    return context.sessions.start(
      {
        actor: user,
        profile,
        workspace: { kind: "repositories", repositories: [] },
        firstMessage: text,
        ...(model && { model: { provider: model.provider, id: model.id } }),
      },
      context.owner,
    );
  } catch (error) {
    throw new BadRequest(
      error instanceof Error ? error.message : String(error),
    );
  }
}
