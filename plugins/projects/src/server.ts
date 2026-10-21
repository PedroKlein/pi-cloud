import { randomUUID } from "node:crypto";
import type { ServerPlugin, ServerPluginContext } from "@pi-cloud/plugins";
import { type Actor, checkoutName } from "@pi-cloud/protocol";
import type { ProjectSummary, ProjectView } from "./model";
import { coordinatorPrompt, runState, threadNotice } from "./prompts";
import { type Project, type ProjectStore, projectStore } from "./projects";
import { modelRef, projectTools, workState } from "./tools";

const deliveryMs = 1000;

export const projects: ServerPlugin = {
  name: "projects",
  register: (context) => {
    const store = projectStore(context.store);
    const user: Actor = `user:${context.owner}`;

    for (const tool of projectTools(store, context)) {
      context.tools.register(tool);
    }

    for (const type of ["TurnStarted", "TurnEnded"] as const) {
      context.events.subscribe(type, ({ session }) => {
        store.touch(session.id);
      });
    }

    context.events.subscribe("TurnEnded", ({ session }) => {
      const thread = store.member(session.id);
      if (thread?.role === "thread") {
        const project = store.get(thread.projectId);
        if (project) {
          store.enqueue(project.coordinatorId, `plugin:projects`, {
            kind: "turn",
            threadId: thread.sessionId,
          });
        }
      }
    });

    context.events.subscribe("SessionStateChanged", ({ session }) => {
      const thread = store.member(session.id);
      const project = thread && store.get(thread.projectId);
      if (
        thread?.role === "thread" &&
        project &&
        (session.status === "interrupted" || session.status === "failed")
      ) {
        store.enqueue(project.coordinatorId, "plugin:projects", {
          kind: "context",
          text: threadNotice(thread, session, `stopped: ${session.status}`, []),
        });
      }
    });

    // Notices and messages wait here until their Session can take them, so
    // none are lost while a provider is offline, and they arrive in order.
    const timer = setInterval(() => {
      deliver(store, context);
    }, deliveryMs);

    context.signal.addEventListener("abort", () => {
      clearInterval(timer);
    });

    context.routes.handle(async (request, path) =>
      route(request, path.split("/"), store, context, user),
    );
  },
};

function deliver(
  store: ProjectStore,
  { sessions, log }: ServerPluginContext,
): void {
  const blocked = new Set<string>();

  for (const queued of store.queued()) {
    if (blocked.has(queued.sessionId)) {
      continue;
    }

    const { delivery, sessionId, actor } = queued;
    const target = sessions.get(sessionId);
    if (target?.archivedAt !== null) {
      log("dropped a delivery to a session that is gone", { sessionId });
      store.delivered(queued.id);
      continue;
    }

    try {
      switch (delivery.kind) {
        case "message":
          sessions.send(sessionId, delivery.text, actor);
          break;
        case "context":
          sessions.notify(sessionId, delivery.text, actor);
          break;
        case "turn": {
          const thread = store.member(delivery.threadId);
          if (thread) {
            sessions.notify(
              sessionId,
              threadNotice(
                thread,
                sessions.get(thread.sessionId),
                "finished a turn",
                sessions.transcript(thread.sessionId),
              ),
              actor,
            );
          }
        }
      }

      store.delivered(queued.id);
    } catch (error) {
      blocked.add(sessionId);
      if (!String(error).includes("offline")) {
        log("delivery failed", { sessionId, error: String(error) });
      }
    }
  }
}

class BadRequest extends Error {}

async function route(
  request: Request,
  path: readonly string[],
  store: ProjectStore,
  context: ServerPluginContext,
  user: Actor,
): Promise<Response> {
  try {
    const [resource, id, child, name] = path;

    if (resource === "projects" && id === undefined) {
      return request.method === "POST"
        ? Response.json(
            view(
              create(await request.json(), store, context, user),
              store,
              context,
            ),
          )
        : Response.json(summaries(store));
    }

    const project = resource === "projects" ? store.get(id ?? "") : undefined;

    if (project && child === undefined && request.method === "GET") {
      return Response.json(view(project, store, context));
    }

    if (project && child === "instructions" && request.method === "POST") {
      const { instructions } = (await request.json()) as {
        instructions?: unknown;
      };

      if (typeof instructions !== "string") {
        throw new BadRequest("instructions must be text");
      }

      store.setInstructions(project.id, instructions);

      return Response.json(
        view(store.get(project.id) ?? project, store, context),
      );
    }

    if (project && child === "memory" && name !== undefined) {
      const content = store.readMemory(project.id, decodeURIComponent(name));

      return content === undefined
        ? Response.json({ error: "not_found" }, { status: 404 })
        : Response.json({ name, content });
    }

    const thread = resource === "threads" ? store.member(id ?? "") : undefined;
    if (thread && child === "state" && request.method === "POST") {
      const { state } = (await request.json()) as { state?: unknown };
      store.setWorkState(thread.sessionId, toState(state));

      return new Response(null, { status: 204 });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof BadRequest || error instanceof SyntaxError) {
      return Response.json({ error: error.message }, { status: 400 });
    }

    throw error;
  }
}

function toState(value: unknown): ReturnType<typeof workState> {
  try {
    return workState(value);
  } catch (error) {
    throw new BadRequest((error as Error).message);
  }
}

function create(
  body: unknown,
  store: ProjectStore,
  { sessions, log }: ServerPluginContext,
  user: Actor,
): Project {
  const { name, instructions, repositories, environment, model } = (body ??
    {}) as Record<string, unknown>;

  if (typeof name !== "string" || name.trim() === "") {
    throw new BadRequest("name is required");
  }

  const urls = Array.isArray(repositories)
    ? repositories.filter(
        (url): url is string => typeof url === "string" && url.trim() !== "",
      )
    : [];

  const names = urls.map(checkoutName);
  if (urls.length === 0 || new Set(names).size !== names.length) {
    throw new BadRequest(
      "a Project needs one or more repositories with different names",
    );
  }

  const draft: Project = {
    id: randomUUID(),
    ownerId: user.slice("user:".length),
    name: name.trim(),
    instructions: typeof instructions === "string" ? instructions : "",
    repositories: urls,
    environmentId:
      typeof environment === "string" && environment !== ""
        ? environment
        : null,
    coordinatorId: "",
    createdAt: new Date().toISOString(),
  };

  let coordinator;
  try {
    const ref = modelRef(
      typeof model === "string" && model.trim() !== ""
        ? model.trim()
        : undefined,
    );

    coordinator = sessions.start({
      ...(ref && { model: ref }),
      actor: user,
      ...(draft.environmentId !== null && { environment: draft.environmentId }),
      workspace: {
        kind: "repositories",
        repositories: urls.map((repository) => ({ repository })),
      },
      systemPrompt: coordinatorPrompt(draft, undefined),
    });
  } catch (error) {
    throw new BadRequest((error as Error).message);
  }

  const project = { ...draft, coordinatorId: coordinator.id };
  store.create(project);

  store.addMember({
    sessionId: coordinator.id,
    projectId: project.id,
    role: "coordinator",
    title: "Coordinator",
    workState: "in_progress",
    lastActivity: project.createdAt,
  });

  log("project created", { project: project.id, coordinator: coordinator.id });

  return project;
}

function summaries(store: ProjectStore): ProjectSummary[] {
  return store.list().map((project) => ({
    id: project.id,
    name: project.name,
    coordinatorId: project.coordinatorId,
    threads: store.threads(project.id).length,
  }));
}

function view(
  project: Project,
  store: ProjectStore,
  { sessions }: ServerPluginContext,
): ProjectView {
  return {
    id: project.id,
    name: project.name,
    instructions: project.instructions,
    repositories: project.repositories,
    environmentId: project.environmentId,
    coordinatorId: project.coordinatorId,
    coordinatorState: runState(sessions.get(project.coordinatorId)),
    threads: store.threads(project.id).map((thread) => {
      const session = sessions.get(thread.sessionId);
      const workspace = session?.workspace;

      return {
        sessionId: thread.sessionId,
        title: thread.title,
        runState: runState(session),
        workState: thread.workState,
        environmentId: session?.environmentId ?? "",
        branch: workspace && "branch" in workspace ? workspace.branch : null,
        lastActivity: thread.lastActivity,
      };
    }),
    memory: store.memory(project.id),
  };
}
