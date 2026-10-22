import { randomUUID } from "node:crypto";
import type {
  SendOutcome,
  ServerPlugin,
  ServerPluginContext,
} from "@pi-cloud/plugins";
import { type Actor, checkoutName } from "@pi-cloud/protocol";
import type { ProjectSummary, ProjectView } from "./model";
import {
  coordinatorPrompt,
  messagedCoordinator,
  runState,
  threadNotice,
  turnError,
} from "./prompts";
import {
  type Member,
  type Project,
  type ProjectStore,
  projectStore,
  type Queued,
} from "./projects";
import { modelRef, projectTools, workState } from "./tools";

const deliveryMs = 1000;
const errorLimit = 300;

export const projects: ServerPlugin = {
  name: "projects",
  register: (context) => {
    const stored = projectStore(context.store);

    // Other plugins, like the library, follow who is in which Project.
    const store: ProjectStore = {
      ...stored,
      addMember: (member) => {
        stored.addMember(member);

        context.events.publish({
          type: "projects.MemberAdded",
          sessionId: member.sessionId,
          projectId: member.projectId,
        });
      },
    };

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

    // The transcript upload can trail TurnEnded, so a turn notice reads the
    // transcript when it is delivered, up to where the thread's next turn began.
    context.events.subscribe("TurnStarted", ({ session }) => {
      if (store.member(session.id)?.role === "thread") {
        store.endTurns(
          session.id,
          context.sessions.transcript(session.id).length,
        );
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
          kind: "message",
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

    const { sessionId } = queued;
    const target = sessions.get(sessionId);
    if (target?.archivedAt !== null) {
      log("dropped a delivery to a session that is gone", { sessionId });
      store.delivered(queued.id);
      continue;
    }

    // A turn notice reads the thread's whole transcript, so don't build one
    // every second for a Session that can't take it.
    const state = runState(target);
    if (state === "offline" || state === "interrupted") {
      blocked.add(sessionId);
      continue;
    }

    try {
      const sent = sendQueued(queued, store, sessions, log);
      if (sent.ok) {
        store.delivered(queued.id);
        continue;
      }

      blocked.add(sessionId);
      if (sent.reason !== "offline") {
        log("delivery failed", { sessionId, reason: sent.reason });
      }
    } catch (error) {
      blocked.add(sessionId);
      log("delivery failed", { sessionId, error: String(error) });
    }
  }
}

function sendQueued(
  { delivery, sessionId, actor }: Queued,
  store: ProjectStore,
  sessions: ServerPluginContext["sessions"],
  log: ServerPluginContext["log"],
): SendOutcome {
  switch (delivery.kind) {
    case "message":
      return sessions.send(sessionId, delivery.text, actor);
    case "context":
      return sessions.notify(sessionId, delivery.text, actor);
    case "turn": {
      const thread = store.member(delivery.threadId);

      return thread
        ? deliverTurn(thread, delivery.end, sessionId, actor, sessions, log)
        : { ok: true };
    }
  }
}

function deliverTurn(
  thread: Member,
  end: number | undefined,
  coordinatorId: string,
  actor: Actor,
  sessions: ServerPluginContext["sessions"],
  log: ServerPluginContext["log"],
): SendOutcome {
  const transcript = sessions.transcript(thread.sessionId).slice(0, end);
  const error = turnError(transcript);

  const notice = threadNotice(
    thread,
    sessions.get(thread.sessionId),
    error === undefined
      ? "finished a turn"
      : `ended its turn with a model error: ${error.slice(0, errorLimit)}`,
    transcript,
  );

  if (error !== undefined) {
    log("thread turn failed", { sessionId: thread.sessionId, error });
  }

  // A thread that messaged the coordinator this turn already started a
  // coordinator turn, so its notice is only context. So is a failed turn: a
  // coordinator woken by it tends to retry the thread on the same model, which
  // fails the same way.
  if (error !== undefined || messagedCoordinator(transcript)) {
    return sessions.notify(coordinatorId, notice, actor);
  }

  return sessions.send(coordinatorId, notice, actor);
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
  const { name, instructions, repositories, environment, model, threadModel } =
    (body ?? {}) as Record<string, unknown>;

  if (typeof name !== "string" || name.trim() === "") {
    throw new BadRequest("name is required");
  }

  const urls = Array.isArray(repositories)
    ? repositories.filter(
        (url): url is string => typeof url === "string" && url.trim() !== "",
      )
    : [];

  const names = urls.map(checkoutName);
  if (
    urls.length === 0 ||
    names.includes(undefined) ||
    new Set(names).size !== names.length
  ) {
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
    threadModel:
      typeof threadModel === "string" && threadModel.trim() !== ""
        ? threadModel.trim()
        : null,
    coordinatorId: "",
    createdAt: new Date().toISOString(),
  };

  try {
    modelRef(draft.threadModel ?? undefined);
  } catch (error) {
    throw new BadRequest(`thread model: ${(error as Error).message}`);
  }

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
    threadModel: project.threadModel,
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
