import type { ServerPlugin, ServerPluginContext } from "@pi-cloud/plugins";
import type { Actor, ModelRef, Session } from "@pi-cloud/protocol";
import { metaPrompt } from "./prompt";

// Meta-sessions change Pi Cloud itself (ADR 0035). They run on the meta
// Profile and stay out of the Session list.
export const meta: ServerPlugin = {
  name: "meta",
  register: (context) => {
    const user: Actor = `user:${context.owner}`;

    // Other Session parts would add tools the confirm can't see into, such
    // as subagents, whose own sessions don't load it.
    context.sessions.loadOnly(["ask", "models", "meta"]);

    const profile = context.profiles.provide("assistant", {
      name: "Pi Cloud assistant",
      packages: [],
      agentsMd: "",
      systemMd: "",
      appendSystemMd: metaPrompt,
      mcpServers: {},
      settings: {},
    });

    context.routes.handle(async (request, path) => {
      if (path !== "sessions") {
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      if (request.method !== "POST") {
        return Response.json(context.sessions.owned(context.owner));
      }

      try {
        return Response.json(
          start(context, user, profile, await request.json()),
          { status: 201 },
        );
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
    });
  },
};

function start(
  context: ServerPluginContext,
  user: Actor,
  profile: string,
  body: unknown,
): Session {
  const { text, model } = (body ?? {}) as { text?: unknown; model?: unknown };

  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("text must be a non-empty string");
  }

  const ref = modelRef(model);

  return context.sessions.start(
    {
      actor: user,
      profile,
      workspace: { kind: "repositories", repositories: [] },
      firstMessage: text,
      ...(ref && { model: ref }),
    },
    context.owner,
  );
}

function modelRef(value: unknown): ModelRef | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const { provider, id } = value as { provider?: unknown; id?: unknown };

  if (
    typeof provider !== "string" ||
    provider === "" ||
    typeof id !== "string" ||
    id === ""
  ) {
    throw new Error("model must have a provider and an id");
  }

  return { provider, id };
}
