import { randomUUID } from "node:crypto";
import {
  BadRequest,
  NotFound,
  type PluginStore,
  readBody,
  type RouteCaller,
  type SendOutcome,
  type ServerPlugin,
  type ServerPluginContext,
  type Static,
  Type,
} from "@pipoca/plugins";
import { type Actor, checkoutName } from "@pipoca/protocol";
import { type ProjectSummary, type ProjectView, workStates } from "./model";
import {
  coordinatorPrompt,
  runState,
  threadNotice,
  threadView,
} from "./prompts";
import {
  type Delivery,
  type Member,
  type Project,
  type ProjectStore,
  projectStore,
  type Queued,
} from "./projects";
import { modelRef, projectTools } from "./tools";
import { projectsToolset } from "./toolset";
import { lastReply, messagedCoordinator, turnError } from "./transcript";

// The settings a Project can change after it starts. Null takes its Profile
// away.
const settingsChange = Type.Object({
  name: Type.Optional(Type.String()),
  goal: Type.Optional(Type.String()),
  instructions: Type.Optional(Type.String()),
  threadModel: Type.Optional(Type.String()),
  profile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const newProject = Type.Object({
  ...settingsChange.properties,
  name: Type.String(),
  repositories: Type.Array(Type.String()),
  environment: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
});

const stateChange = Type.Object({ state: Type.Enum(workStates) });

const deliveryMs = 1000;
const errorLimit = 300;

export const projects: ServerPlugin = {
  name: "projects",
  register: (context) => {
    // Other plugins, like the library, follow who is in which Project.
    // Every write can change what an open Project shows (ADR 0038).
    const tables: PluginStore = {
      ...context.store,
      run: (sql, ...params) => {
        context.store.run(sql, ...params);
        context.changes.publish("projects");
      },
    };

    const store = projectStore(tables, (member) => {
      context.events.publish({
        type: "projects.MemberAdded",
        sessionId: member.sessionId,
        projectId: member.projectId,
      });
    });

    // Projects from before Sessions had owners (ADR 0028).
    for (const project of store.list()) {
      for (const sessionId of [
        project.coordinatorId,
        ...store.threads(project.id).map((thread) => thread.sessionId),
      ]) {
        context.sessions.adopt(sessionId, project.id);
      }
    }

    for (const tool of projectTools(store, context)) {
      context.tools.register(tool);
    }

    context.toolsets.register(projectsToolset);

    for (const type of ["TurnStarted", "TurnEnded"] as const) {
      context.events.subscribe(type, ({ session }) => {
        store.touch(session.id);
      });
    }

    // The transcript upload can trail TurnEnded, so a turn notice reads the
    // transcript when it is delivered, up to where the turn ended.
    context.events.subscribe("TurnEnded", ({ session, transcriptLength }) => {
      const thread = store.member(session.id);
      if (thread?.role === "thread") {
        const project = store.get(thread.projectId);
        if (project) {
          store.enqueue(project.coordinatorId, `plugin:projects`, {
            kind: "turn",
            threadId: thread.sessionId,
            ...(transcriptLength !== undefined && { end: transcriptLength }),
          });
        }
      }
    });

    // Every restart interrupts the threads it finds idle too, and those lost
    // nothing, so a notice would only cost the coordinator a turn.
    context.events.subscribe("SessionStateChanged", ({ session, previous }) => {
      const thread = store.member(session.id);
      const project = thread && store.get(thread.projectId);
      if (
        thread?.role === "thread" &&
        project &&
        ((session.status === "interrupted" && previous === "running") ||
          session.status === "failed")
      ) {
        store.enqueue(project.coordinatorId, "plugin:projects", {
          kind: "message",
          ...threadNotice(thread, session, `stopped: ${session.status}`),
        });
      }
    });

    // A Project goes and comes back with its coordinator, and takes every
    // Session it owns along (ADR 0028).
    context.events.subscribe("SessionArchived", ({ session }) => {
      const project = coordinated(store, session.id);
      if (project) {
        for (const owned of context.sessions.owned(project.id)) {
          try {
            context.sessions.archive(owned.id);
          } catch (error) {
            context.log("could not archive a Session with its Project", {
              sessionId: owned.id,
              error: String(error),
            });
          }
        }
      }
    });

    // Threads archived before the Project stay archived.
    context.events.subscribe("SessionUnarchived", ({ session, archivedAt }) => {
      const project = coordinated(store, session.id);
      if (project) {
        for (const owned of context.sessions.owned(project.id, {
          archived: true,
        })) {
          if (owned.archivedAt === null || owned.archivedAt < archivedAt) {
            continue;
          }

          try {
            context.sessions.unarchive(owned.id);
          } catch (error) {
            context.log("could not bring back a Session with its Project", {
              sessionId: owned.id,
              error: String(error),
            });
          }
        }
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

    context.routes.handle(async (request, path, caller) =>
      route(request, path.split("/"), store, context, caller),
    );
  },
};

function coordinated(
  store: ProjectStore,
  sessionId: string,
): Project | undefined {
  const member = store.member(sessionId);

  return member?.role === "coordinator"
    ? store.get(member.projectId)
    : undefined;
}

// The store can refuse a write, such as while another process holds its lock.
// A delivery waits for the next tick then, and the server keeps running.
function deliver(store: ProjectStore, context: ServerPluginContext): void {
  try {
    deliverQueued(store, context);
  } catch (error) {
    context.log("deliveries wait for the next tick after an error", {
      error: String(error),
    });
  }
}

function deliverQueued(
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
    if (
      state === "offline" ||
      state === "interrupted" ||
      awaitsTranscript(queued.delivery, sessions)
    ) {
      blocked.add(sessionId);
      continue;
    }

    try {
      const sent = sendQueued(queued, store, sessions, log);
      if (!sent.ok && sent.reason === "offline") {
        blocked.add(sessionId);
        continue;
      }

      if (!sent.ok) {
        log("dropped a delivery to a session that is gone", {
          sessionId,
          reason: sent.reason,
        });
      }
    } catch (error) {
      log("dropped a delivery that failed", {
        id: queued.id,
        sessionId,
        error: String(error),
      });
    }

    store.delivered(queued.id);
  }
}

// A turn notice waits for the rest of its turn, which its thread's host
// uploads even after an outage, until the thread is archived.
function awaitsTranscript(
  delivery: Delivery,
  sessions: ServerPluginContext["sessions"],
): boolean {
  return (
    delivery.kind === "turn" &&
    delivery.end !== undefined &&
    sessions.get(delivery.threadId)?.archivedAt === null &&
    sessions.transcriptLength(delivery.threadId) < delivery.end
  );
}

function sendQueued(
  { delivery, sessionId, actor }: Queued,
  store: ProjectStore,
  sessions: ServerPluginContext["sessions"],
  log: ServerPluginContext["log"],
): SendOutcome {
  switch (delivery.kind) {
    case "message":
      return sessions.send(sessionId, delivery.text, actor, delivery.notice);
    case "context":
      return sessions.notify(sessionId, delivery.text, actor, delivery.notice);
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

  const { text, notice } = threadNotice(
    thread,
    sessions.get(thread.sessionId),
    error === undefined
      ? "finished a turn"
      : `ended its turn with a model error: ${error.slice(0, errorLimit)}`,
    lastReply(transcript),
  );

  if (error !== undefined) {
    log("thread turn failed", { sessionId: thread.sessionId, error });
  }

  // A thread that messaged the coordinator this turn already started a
  // coordinator turn, so its notice is only context. So is a failed turn: a
  // coordinator woken by it tends to retry the thread on the same model, which
  // fails the same way.
  if (error !== undefined || messagedCoordinator(transcript)) {
    return sessions.notify(coordinatorId, text, actor, notice);
  }

  return sessions.send(coordinatorId, text, actor, notice);
}

async function route(
  request: Request,
  path: readonly string[],
  store: ProjectStore,
  context: ServerPluginContext,
  caller: RouteCaller,
): Promise<Response> {
  const [resource, id, child, name] = path;

  // The plugin has no Session part that sends requests.
  if (caller.kind !== "user") {
    throw new NotFound(`no route ${path.join("/")}`);
  }

  if (resource === "projects" && id === undefined) {
    if (request.method === "POST") {
      return Response.json(
        view(
          create(
            await readBody(request, newProject),
            store,
            context,
            caller.actor,
          ),
          store,
          context,
        ),
      );
    }

    if (request.method !== "GET") {
      throw new NotFound(`no route ${path.join("/")}`);
    }

    return Response.json(summaries(store, context));
  }

  const project = resource === "projects" ? store.get(id ?? "") : undefined;

  if (project && child === undefined && request.method === "GET") {
    return Response.json(view(project, store, context));
  }

  if (project && child === "settings" && request.method === "POST") {
    store.update(
      project.id,
      settings(project, await readBody(request, settingsChange)),
    );

    return Response.json(
      view(store.get(project.id) ?? project, store, context),
    );
  }

  if (project && child === "memory" && name !== undefined) {
    const content = store.readMemory(project.id, decoded(name));

    if (content === undefined) {
      throw new NotFound(`no memory file ${name}`);
    }

    return Response.json({ name, content });
  }

  const thread = resource === "threads" ? store.member(id ?? "") : undefined;

  if (thread?.role === "thread" && child === undefined) {
    return Response.json({
      projectId: thread.projectId,
      ...threadView(thread, context.sessions.get(thread.sessionId)),
    });
  }

  if (thread && child === "state" && request.method === "POST") {
    const { state } = await readBody(request, stateChange);
    store.setWorkState(thread.sessionId, state);

    return new Response(null, { status: 204 });
  }

  throw new NotFound(`no route ${path.join("/")}`);
}

function decoded(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch (error) {
    throw new BadRequest((error as Error).message);
  }
}

// The settings a Project can change after it starts. The repositories and
// Environment stay, since the coordinator's workspace was built from them.
function settings(
  project: Project,
  {
    name,
    goal,
    instructions,
    threadModel,
    profile,
  }: Static<typeof settingsChange>,
): Pick<
  Project,
  "name" | "goal" | "instructions" | "threadModel" | "profileId"
> {
  if (name?.trim() === "") {
    throw new BadRequest("name must not be empty");
  }

  const model =
    threadModel === undefined
      ? project.threadModel
      : threadModel.trim() || null;

  try {
    modelRef(model ?? undefined);
  } catch (error) {
    throw new BadRequest(`thread model: ${(error as Error).message}`);
  }

  return {
    name: name?.trim() ?? project.name,
    goal: goal?.trim() ?? project.goal,
    instructions: instructions ?? project.instructions,
    threadModel: model,
    profileId: profile === undefined ? project.profileId : profileOf(profile),
  };
}

function profileOf(profile: string | null): string | null {
  const id = profile?.trim() ?? "";

  return id === "" ? null : id;
}

function create(
  {
    name,
    goal,
    instructions,
    repositories,
    environment,
    profile,
    model,
    threadModel,
  }: Static<typeof newProject>,
  store: ProjectStore,
  { sessions, log }: ServerPluginContext,
  user: `user:${string}`,
): Project {
  if (name.trim() === "") {
    throw new BadRequest("name is required");
  }

  const urls = repositories.filter((url) => url.trim() !== "");

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
    goal: goal?.trim() ?? "",
    instructions: instructions ?? "",
    repositories: urls,
    environmentId: (environment ?? "") || null,
    profileId: (profile ?? "") || null,
    threadModel: (threadModel ?? "").trim() || null,
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
    const ref = modelRef((model ?? "").trim() || undefined);

    coordinator = sessions.start(
      {
        ...(ref && { model: ref }),
        actor: user,
        ...(draft.environmentId !== null && {
          environment: draft.environmentId,
        }),
        ...(draft.profileId !== null && { profile: draft.profileId }),
        workspace: {
          kind: "repositories",
          repositories: urls.map((repository) => ({ repository })),
        },
        systemPrompt: coordinatorPrompt(draft, undefined),
      },
      draft.id,
    );
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

function summaries(
  store: ProjectStore,
  { sessions }: ServerPluginContext,
): ProjectSummary[] {
  return store.list().map((project) => {
    const threads = store.threads(project.id);

    return {
      id: project.id,
      name: project.name,
      coordinatorId: project.coordinatorId,
      coordinatorState: runState(sessions.get(project.coordinatorId)),
      repositories: project.repositories.length,
      threads: threads.length,
      needsYou: threads.filter(
        (thread) =>
          thread.workState === "blocked" ||
          runState(sessions.get(thread.sessionId)) === "waiting",
      ).length,
    };
  });
}

function view(
  project: Project,
  store: ProjectStore,
  { sessions }: ServerPluginContext,
): ProjectView {
  return {
    id: project.id,
    name: project.name,
    goal: project.goal,
    instructions: project.instructions,
    repositories: project.repositories,
    environmentId: project.environmentId,
    profileId: project.profileId,
    threadModel: project.threadModel,
    coordinatorId: project.coordinatorId,
    coordinatorState: runState(sessions.get(project.coordinatorId)),
    threads: store
      .threads(project.id)
      .map((thread) => threadView(thread, sessions.get(thread.sessionId))),
    memory: store.memory(project.id),
  };
}
