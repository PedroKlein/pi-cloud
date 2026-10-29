import { randomUUID } from "node:crypto";
import type { KernelEvent, ModelOffer, StartRequest } from "@pipoca/plugins";
import {
  type Actor,
  type Assignment,
  type Attempt,
  type Command,
  type Environment,
  type EnvironmentUpdate,
  type GitLogin,
  leaseMs,
  type LiveEvent,
  movable,
  type LivePost,
  liveSurface,
  type ModelRef,
  type ProfileContent,
  type ProfileFiles,
  type Removal,
  type RemovalPost,
  type Session,
  type SessionEnvironment,
  type SessionEvent,
  type SessionOwner,
  type SessionStatus,
  type StartFailure,
  type TranscriptAck,
  type TranscriptBatch,
  trustedRepository,
  type TrustAnswer,
  type Work,
  type WorkPoll,
  type WorkspaceRequest,
} from "@pipoca/protocol";
import { contentFiles, ProfileTooBig } from "@pipoca/profiles";
import { placesOn, placesOnNewRunner, uniqueModels } from "./placement";
import { RunnerPolls } from "./runner-polls";

export type StoredSession = Omit<Session, "online" | "waiting">;

export type StoredEnvironment = Omit<
  Environment,
  | "online"
  | "onDemand"
  | "runners"
  | "folders"
  | "models"
  | "registeredModels"
  | "secrets"
> & { readonly secrets: Readonly<Record<string, string>> };

// v1 has one user, who owns every record (ADR 0015).
export const owner = "local";

export interface SessionStore {
  profile: (id: string) =>
    | (ProfileContent & {
        readonly id: string;
        readonly ownerId: string | null;
      })
    | undefined;
  // Throws ProfileTooBig for a Profile runners shouldn't download.
  profileFiles: (id: string) => ProfileFiles | undefined;
  defaultProfileId: (ownerId: string) => string;
  repositoryTrust: (ownerId: string, repository: string) => boolean | null;
  setRepositoryTrust: (
    ownerId: string,
    repository: string,
    trusted: boolean,
  ) => void;
  ensureEnvironment: (provider: string) => void;
  // The models each runner of an Environment last reported (ADR 0044).
  registeredModels: (provider: string) => readonly ModelRef[];
  setRegisteredModels: (
    provider: string,
    runner: string,
    models: readonly ModelRef[],
  ) => void;
  environments: () => readonly StoredEnvironment[];
  updateEnvironment: (environment: StoredEnvironment) => void;
  insert: (session: StoredSession) => void;
  update: (session: StoredSession) => void;
  get: (id: string) => StoredSession | undefined;
  list: (options: {
    readonly includeArchived: boolean;
    readonly owner?: SessionOwner;
  }) => readonly StoredSession[];
  setOwner: (id: string, owner: SessionOwner) => void;
  byEnvironment: (
    provider: string,
    statuses: readonly SessionStatus[],
  ) => readonly StoredSession[];
  byRunner: (
    runner: string,
    statuses: readonly SessionStatus[],
  ) => readonly StoredSession[];
  // Removals for the runner's workspaces, and for Sessions in its
  // Environment that never reached a runner.
  pendingRemovals: (
    provider: string,
    runner: string,
  ) => readonly StoredSession[];
  transcriptLength: (id: string) => number;
  appendTranscript: (
    id: string,
    start: number,
    lines: readonly string[],
  ) => void;
  transcript: (id: string, from: number) => readonly string[];
  setTitle: (id: string, title: string) => void;
  setModel: (id: string, model: ModelRef) => void;
}

export type Rejection =
  | "not_found"
  | "stale_generation"
  | "offline"
  | "archived"
  | "not_kept"
  | "unknown_environment"
  | "environment_exists"
  | "unknown_profile"
  | "not_movable";

export type Result<T, R extends Rejection = Rejection> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: R };

export type SessionPlugins = Required<
  Pick<Assignment, "plugins" | "pluginSettings">
> & {
  // Session plugins that load only in the Sessions their plugin owns.
  readonly ownSessionsOnly?: readonly string[];
  // The Session plugins that load in a plugin's own Sessions, for plugins
  // that limit them.
  readonly loadOnly?: Readonly<Record<string, readonly string[]>>;
  // The installed plugins' Session parts, by name, with their bundles' hash.
  readonly installedParts?: Readonly<Record<string, string>>;
};

export interface SessionsOptions {
  readonly pollWaitMs?: number;
  readonly offlineAfterMs?: number;
  readonly leaseMs?: number;
  readonly events?: (event: KernelEvent) => void;
  // Called whenever a Session starts or its view changes (ADR 0038).
  readonly changed?: () => void;
  // Called whenever a runner comes online or goes offline.
  readonly runnersChanged?: () => void;
  // The plugins whose Session parts a Session gets when it starts, and their
  // settings.
  readonly sessionPlugins?: () => SessionPlugins;
  readonly offeredModels?: ModelOffer;
  // Whether a plugin starts runners for the Environment on demand.
  readonly startsRunners?: (environmentId: string) => boolean;
  // A Profile a plugin provides, which only the plugin's own Sessions run on.
  readonly pluginProfile?: (id: string) => PluginProfile | undefined;
  // The git hosts a user connected (ADR 0043).
  readonly gitLogins?: (userId: string) => readonly GitLogin[];
}

export interface PluginProfile {
  readonly plugin: string;
  readonly profile: ProfileContent & { readonly id: string };
}

// The server adds the Profiles, which Sessions don't hold.
export interface Claim extends Omit<Work, "profiles" | "start"> {
  readonly start: readonly Assignment[];
  readonly interrupted: readonly Attempt[];
}

type Listener<T> = (value: T) => void;

// Enough to catch a browser retrying a send; ids only need to outlive retries.
const maxRequestIds = 100;
const claimableStatuses: readonly SessionStatus[] = ["queued", "interrupted"];
const attempting: readonly SessionStatus[] = ["starting", "idle", "running"];

// A message to a Session whose runner hasn't connected yet waits for it, as
// the first message does.
const unhosted: readonly SessionStatus[] = ["queued", "starting"];

export class Sessions {
  readonly #store: SessionStore;
  readonly #polls: RunnerPolls;
  readonly #events: (event: KernelEvent) => void;
  readonly #changed: () => void;
  readonly #runnersChanged: () => void;
  readonly #sessionPlugins: () => SessionPlugins;
  readonly #offeredModels: ModelOffer;
  readonly #startsRunners: (environmentId: string) => boolean;
  readonly #pluginProfile: (id: string) => PluginProfile | undefined;
  readonly #gitLogins: (userId: string) => readonly GitLogin[];
  readonly #watchers = new Map<string, Set<Listener<SessionEvent>>>();
  readonly #hosts = new Map<
    string,
    { readonly send: Listener<Command>; readonly end: () => void }
  >();
  readonly #requestIds = new Map<string, Set<string>>();
  readonly #held = new Map<string, Command[]>();
  readonly #hostedGeneration = new Map<string, number>();
  readonly #reported = new Map<string, string>();
  readonly #surfaces = new Map<
    string,
    { readonly generation: number; readonly events: Map<string, LiveEvent> }
  >();

  constructor(store: SessionStore, options: SessionsOptions = {}) {
    this.#store = store;

    this.#polls = new RunnerPolls({
      pollWaitMs: options.pollWaitMs ?? 10_000,
      offlineAfterMs: options.offlineAfterMs ?? 30_000,
      leaseMs: options.leaseMs ?? leaseMs,
      onlineChanged: (runner) => {
        this.#onlineChanged(runner);
      },
    });

    this.#events = options.events ?? (() => undefined);
    this.#changed = options.changed ?? (() => undefined);
    this.#runnersChanged = options.runnersChanged ?? (() => undefined);

    this.#sessionPlugins =
      options.sessionPlugins ?? (() => ({ plugins: [], pluginSettings: {} }));

    this.#offeredModels = options.offeredModels ?? (() => ({ models: [] }));
    this.#startsRunners = options.startsRunners ?? (() => false);
    this.#pluginProfile = options.pluginProfile ?? (() => undefined);
    this.#gitLogins = options.gitLogins ?? (() => []);
  }

  // The one way a Session starts, for the UI and plugins alike (ADR 0015).
  start(request: StartRequest, ownedBy?: SessionOwner): Result<Session> {
    const environments = this.#store.environments();

    const environment =
      request.environment === undefined
        ? environments[0]
        : environments.find(({ id }) => id === request.environment);

    if (!environment) {
      return { ok: false, reason: "unknown_environment" };
    }

    const profileId = request.profile ?? this.#store.defaultProfileId(owner);
    const provided = this.#pluginProfile(profileId);

    const stored = this.#store.profile(profileId);

    // Shared Profiles have no owner (ADR 0041).
    const usable =
      provided === undefined
        ? stored !== undefined &&
          (stored.ownerId === null || stored.ownerId === owner)
        : provided.plugin === ownedBy?.plugin;

    if (!usable) {
      return { ok: false, reason: "unknown_profile" };
    }

    const id = randomUUID();

    const session: StoredSession = {
      id,
      environmentId: environment.id,
      ownerId: owner,
      owner: ownedBy ?? null,
      provider: environment.provider,
      runner: null,
      profileId,
      workspace:
        request.workspace.kind === "folder"
          ? request.workspace
          : { ...request.workspace, branch: `pipoca/${id.slice(0, 8)}` },
      model:
        request.model ?? this.#offeredModels(environment.id).default ?? null,
      thinking: request.thinking ?? null,
      systemPrompt: request.systemPrompt ?? null,
      firstMessage: request.firstMessage ?? null,
      title: null,
      status: "queued",
      generation: 0,
      createdAt: new Date().toISOString(),
      interruptedAt: null,
      error: null,
      archivedAt: null,
      workspaceRemoval: null,
      workspaceKeptReason: null,
      startedBy: this.#starter(request.actor),
    };

    this.#store.insert(session);
    this.#polls.wake(session.provider);
    const view = this.#view(session);
    this.#changed();

    this.#events({
      type: "SessionCreated",
      session: view,
      actor: request.actor,
    });

    return { ok: true, value: view };
  }

  // A fork is a new Session that starts from another's transcript, on its
  // own branch from the one that Session works on, in any Environment
  // (ADR 0034). Only what the Session pushed reaches another machine, so a
  // Session in a folder of its machine forks only within its Environment.
  // A fork belongs to no plugin, so a plugin's prompt stays behind.
  fork(
    id: string,
    request: { readonly environment?: string; readonly actor: Actor },
  ): Result<Session> {
    const source = this.#store.get(id);
    if (!source) {
      return { ok: false, reason: "not_found" };
    }

    const environment = request.environment ?? source.environmentId;
    if (environment !== source.environmentId && !movable(source.workspace)) {
      return { ok: false, reason: "not_movable" };
    }

    // A fork belongs to no plugin, so it can't keep a plugin's Profile.
    const forked = this.start({
      environment,
      ...(this.#pluginProfile(source.profileId) === undefined && {
        profile: source.profileId,
      }),
      workspace: forkedWorkspace(source),
      ...(source.model && { model: source.model }),
      ...(source.thinking && { thinking: source.thinking }),
      ...(source.owner === null &&
        source.systemPrompt !== null && { systemPrompt: source.systemPrompt }),
      actor: request.actor,
    });

    if (!forked.ok) {
      return forked;
    }

    this.#store.appendTranscript(
      forked.value.id,
      0,
      this.#store.transcript(id, 0),
    );

    if (source.title !== null) {
      this.#store.setTitle(
        forked.value.id,
        `${Array.from(source.title).slice(0, titleLength).join("")} (fork)`,
      );
    }

    return { ok: true, value: this.get(forked.value.id) ?? forked.value };
  }

  list({
    archived = false,
    owner: ownedBy,
  }: {
    readonly archived?: boolean;
    readonly owner?: SessionOwner;
  } = {}): readonly Session[] {
    return this.#store
      .list({ includeArchived: archived, ...(ownedBy && { owner: ownedBy }) })
      .map((session) => this.#view(session));
  }

  // Gives an owner to a Session started before it had one. A Session's owner
  // never changes once set.
  adopt(id: string, ownedBy: SessionOwner): Result<Session> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (session.owner !== null) {
      return { ok: true, value: this.#view(session) };
    }

    this.#store.setOwner(id, ownedBy);
    const adopted = this.#view({ ...session, owner: ownedBy });
    this.#emit(id, { type: "session", session: adopted });

    return { ok: true, value: adopted };
  }

  archive(id: string): Result<Session> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (session.archivedAt !== null) {
      return { ok: true, value: this.#view(session) };
    }

    const archived: StoredSession = {
      ...session,
      status: "stopped",
      archivedAt: new Date().toISOString(),
      workspaceRemoval: session.workspace.kind === "folder" ? null : "pending",
      workspaceKeptReason: null,
    };

    this.#hosts.get(id)?.end();
    this.#requestIds.delete(id);
    this.#update(archived);
    this.#polls.wake(session.provider);
    this.#events({ type: "SessionArchived", session: this.#view(archived) });

    return { ok: true, value: this.#view(archived) };
  }

  unarchive(id: string): Result<Session> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (session.archivedAt === null) {
      return { ok: true, value: this.#view(session) };
    }

    // A Session's Profile is fixed, so once it is deleted the Session can't
    // run again (ADR 0031).
    if (!this.#profile(session.profileId)) {
      return { ok: false, reason: "unknown_profile" };
    }

    const unarchived: StoredSession = {
      ...session,
      status: "queued",
      archivedAt: null,
      workspaceRemoval: null,
      workspaceKeptReason: null,
    };

    this.#update(unarchived);
    this.#polls.wake(session.provider);

    this.#events({
      type: "SessionUnarchived",
      session: this.#view(unarchived),
      archivedAt: session.archivedAt,
    });

    return { ok: true, value: this.#view(unarchived) };
  }

  forceRemoval(id: string): Result<Session> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (session.workspaceRemoval !== "kept") {
      return { ok: false, reason: "not_kept" };
    }

    const forced: StoredSession = {
      ...session,
      workspaceRemoval: "forced",
      workspaceKeptReason: null,
    };

    this.#update(forced);
    this.#polls.wake(session.provider);

    return { ok: true, value: this.#view(forced) };
  }

  reportRemoval(id: string, report: RemovalPost): Result<undefined> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    // An unarchive can land while the removal runs, and a new archive after
    // it. The workspace is gone either way and comes back from restore, but
    // only a report from this archive's generation settles the removal.
    const settles =
      session.archivedAt !== null && report.generation === session.generation;

    this.#update({
      ...session,
      workspace:
        report.outcome === "removed" ? report.restore : session.workspace,
      ...(settles && {
        workspaceRemoval: report.outcome,
        workspaceKeptReason: report.outcome === "kept" ? report.reason : null,
      }),
    });

    return { ok: true, value: undefined };
  }

  get(id: string): Session | undefined {
    const session = this.#store.get(id);

    return session && this.#view(session);
  }

  createEnvironment(
    provider: string,
  ): Result<Environment, "environment_exists"> {
    if (this.#store.environments().some((each) => each.provider === provider)) {
      return { ok: false, reason: "environment_exists" };
    }

    this.#store.ensureEnvironment(provider);

    const created = this.environments().find(
      (each) => each.provider === provider,
    );

    if (!created) {
      throw new Error(`environment ${provider} was not stored`);
    }

    return { ok: true, value: created };
  }

  updateEnvironment(
    id: string,
    update: EnvironmentUpdate,
  ): Result<Environment, "unknown_environment"> {
    const environment = this.#store
      .environments()
      .find((each) => each.id === id);

    if (!environment) {
      return { ok: false, reason: "unknown_environment" };
    }

    const secrets = Object.fromEntries(
      Object.entries({ ...environment.secrets, ...update.secrets }).filter(
        (entry): entry is [string, string] => entry[1] !== null,
      ),
    );

    this.#store.updateEnvironment({
      ...environment,
      name: update.name ?? environment.name,
      isolation: update.isolation ?? environment.isolation,
      image: update.image === undefined ? environment.image : update.image,
      setupScript: update.setupScript ?? environment.setupScript,
      variables: update.variables ?? environment.variables,
      secrets,
    });

    const updated = this.environments().find((each) => each.id === id);

    return updated
      ? { ok: true, value: updated }
      : { ok: false, reason: "unknown_environment" };
  }

  environments(): readonly Environment[] {
    return this.#store.environments().map((environment) => {
      const runners = this.#polls.runners(environment.provider);
      const offered = this.#offeredModels(environment.id).models;

      return {
        ...environment,
        secrets: Object.keys(environment.secrets),
        online: runners.some(({ online }) => online),
        onDemand: this.#startsRunners(environment.id),
        runners: runners.map(({ name, online, capacity }) => ({
          name,
          online,
          capacity,
          running: this.#store.byRunner(name, attempting).length,
        })),
        folders: [
          ...new Set(runners.flatMap(({ inventory }) => inventory.folders)),
        ],
        models: uniqueModels([
          ...offered,
          ...runners.flatMap(({ inventory }) => inventory.models),
          ...this.#store.registeredModels(environment.provider),
        ]),
      };
    });
  }

  // Sessions no online runner in the pool can take now, for a plugin that
  // starts runners on demand (ADR 0032): those beyond the room its runners
  // have, and those held by a runner that went away. A Session that only an
  // online runner can take waits for it, since a new runner never gets it,
  // and one that can move waits for its runner's lease to lapse.
  unplaced(environmentId: string): readonly Session[] {
    const environment = this.#store
      .environments()
      .find(({ id }) => id === environmentId);

    if (environment === undefined) {
      return [];
    }

    const runners = this.#polls.runners(environment.provider);
    const online = runners.filter((runner) => runner.online);

    const pool = {
      runners,
      leaseLapsed: (name: string) =>
        this.#polls.leaseLapsed(name, environment.provider),
    };

    const room = new Map(
      online.map(({ name, capacity }) => [
        name,
        capacity === null
          ? Infinity
          : capacity - this.#store.byRunner(name, attempting).length,
      ]),
    );

    const takesSlot = (session: StoredSession): boolean => {
      const runner = online.find(
        ({ name }) =>
          (room.get(name) ?? 0) > 0 && this.#mayTake(session, name, pool),
      );

      if (runner !== undefined) {
        room.set(runner.name, (room.get(runner.name) ?? 0) - 1);
      }

      return runner !== undefined;
    };

    const unclaimed = (session: StoredSession): boolean =>
      !online.some(({ name }) => name === session.runner) &&
      !takesSlot(session) &&
      (session.runner === null
        ? placesOnNewRunner(session, pool)
        : !movable(session.workspace) || pool.leaseLapsed(session.runner));

    // A Session with a runner of its own waits for it while it is online.
    return this.#store
      .byEnvironment(environment.provider, [
        ...claimableStatuses,
        ...attempting,
      ])
      .filter((session) =>
        runners.some(({ inventory }) => inventory.session === session.id)
          ? !online.some(({ inventory }) => inventory.session === session.id)
          : unclaimed(session),
      )
      .map((session) => this.#view(session));
  }

  // A runner started for one Session takes only that Session, and that
  // Session goes only to such a runner while one is known.
  #mayTake(
    session: StoredSession,
    runner: string,
    pool: Parameters<typeof placesOn>[2],
  ): boolean {
    const dedicated = pool.runners.find(({ name }) => name === runner)
      ?.inventory.session;

    if (dedicated !== undefined) {
      return dedicated === session.id;
    }

    return (
      !pool.runners.some(({ inventory }) => inventory.session === session.id) &&
      placesOn(session, runner, pool)
    );
  }

  // A runner polls for the Environment whose pool it joins (ADR 0032).
  async claim(
    runner: { readonly name: string; readonly environment: string },
    { running, folders, models, registeredModels, capacity, session }: WorkPoll,
    signal: AbortSignal,
  ): Promise<Claim> {
    this.#store.ensureEnvironment(runner.environment);

    if (registeredModels !== undefined) {
      this.#rememberModels(runner, registeredModels);
    }

    const endPoll = this.#polls.begin(runner.name, {
      environment: runner.environment,
      capacity: capacity ?? null,
      inventory: { folders, models, ...(session !== undefined && { session }) },
    });

    const work = (): Omit<Claim, "interrupted"> => ({
      start: signal.aborted
        ? []
        : this.#claimNext(runner, capacity, running.length),
      unload: this.#stale(running),
      remove: this.#removals(runner),
    });

    try {
      const interrupted = this.#interruptMissing(runner.name, running);
      const first = work();
      if (first.start.length > 0 || first.unload.length > 0 || signal.aborted) {
        return { ...first, interrupted };
      }

      await this.#polls.waitForWork(runner.name, signal);

      return { ...work(), interrupted };
    } finally {
      endPoll();
    }
  }

  // Written only when they change, since runners poll all the time.
  #rememberModels(
    runner: { readonly name: string; readonly environment: string },
    models: readonly ModelRef[],
  ): void {
    const key = JSON.stringify(models);
    if (this.#reported.get(runner.name) === key) {
      return;
    }

    this.#reported.set(runner.name, key);
    this.#store.setRegisteredModels(runner.environment, runner.name, models);
    this.#runnersChanged();
  }

  // Kept for the repository, so later Sessions in it don't ask again.
  trust(id: string, answer: TrustAnswer): Result<undefined> {
    const current = this.#current(id, answer.generation);
    if (!current.ok) {
      return current;
    }

    const repository = trustedRepository(current.value.workspace);
    if (repository !== undefined) {
      this.#store.setRepositoryTrust(
        current.value.ownerId,
        repository,
        answer.trusted,
      );
    }

    return { ok: true, value: undefined };
  }

  #trusted(session: StoredSession): boolean | null {
    const repository = trustedRepository(session.workspace);

    return repository === undefined
      ? null
      : this.#store.repositoryTrust(session.ownerId, repository);
  }

  fail(id: string, failure: StartFailure): Result<undefined> {
    const current = this.#current(id, failure.generation);
    if (!current.ok) {
      return current;
    }

    this.#update({ ...current.value, status: "failed", error: failure.error });

    return { ok: true, value: undefined };
  }

  appendTranscript(id: string, batch: TranscriptBatch): Result<TranscriptAck> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    // An archived attempt still flushes its last lines while it unloads, so a
    // batch is stale only before the first attempt or after a newer one.
    if (session.generation === 0 || session.generation !== batch.generation) {
      return { ok: false, reason: "stale_generation" };
    }

    const length = this.#store.transcriptLength(id);

    const fresh =
      batch.start <= length ? batch.lines.slice(length - batch.start) : [];

    if (fresh.length > 0) {
      this.#store.appendTranscript(id, length, fresh);

      const title = titleAfter(session.title, fresh);
      if (title !== session.title && title !== null) {
        this.#store.setTitle(id, title);
      }

      const model = modelAfter(session.model, fresh);
      if (model !== session.model && model !== null) {
        this.#store.setModel(id, model);
      }

      if (title !== session.title || model !== session.model) {
        this.#emit(id, {
          type: "session",
          session: this.#view({ ...session, title, model }),
        });
      }

      fresh.forEach((entry, i) => {
        this.#emit(id, { type: "entry", line: length + i, entry });
      });
    }

    return { ok: true, value: { acked: length + fresh.length } };
  }

  publish(id: string, post: LivePost): Result<undefined> {
    const current = this.#current(id, post.generation);
    if (!current.ok) {
      return current;
    }

    let session = current.value;
    for (const event of post.events) {
      if (event.type === "status") {
        const turnStarted =
          session.status !== "running" && event.status === "running";

        const turnEnded =
          session.status === "running" && event.status === "idle";

        session = { ...session, status: event.status };
        this.#update(session);
        if (turnStarted) {
          this.#events({ type: "TurnStarted", session: this.#view(session) });
        }

        if (turnEnded) {
          this.#events({
            type: "TurnEnded",
            session: this.#view(session),
            ...(event.transcriptLength !== undefined && {
              transcriptLength: event.transcriptLength,
            }),
          });
        }
      }

      const waiting = this.#waiting(session);
      this.#trackSurface(id, post.generation, event);

      if (this.#waiting(session) !== waiting) {
        this.#emit(id, { type: "session", session: this.#view(session) });
      }

      this.#emit(id, { type: "live", event });
    }

    return { ok: true, value: undefined };
  }

  watch(
    id: string,
    listener: Listener<SessionEvent>,
    fromLine = 0,
  ): Result<{
    readonly replay: readonly SessionEvent[];
    readonly stop: () => void;
  }> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    const watchers = this.#watchers.get(id) ?? new Set();
    this.#watchers.set(id, watchers);
    watchers.add(listener);

    const replay: SessionEvent[] = [
      { type: "session", session: this.#view(session) },
      ...this.#store.transcript(id, fromLine).map((entry, i): SessionEvent => ({
        type: "entry",
        line: fromLine + i,
        entry,
      })),
      ...this.#openSurfaces(session).map((event): SessionEvent => ({
        type: "live",
        event,
      })),
    ];

    return {
      ok: true,
      value: {
        replay,
        stop: () => {
          watchers.delete(listener);
          if (watchers.size === 0 && this.#watchers.get(id) === watchers) {
            this.#watchers.delete(id);
          }
        },
      },
    };
  }

  send(
    id: string,
    command: Command,
  ): Result<undefined, "not_found" | "archived" | "offline"> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (session.archivedAt !== null) {
      return { ok: false, reason: "archived" };
    }

    const host = this.#hosts.get(id);
    if (!this.#online(session)) {
      return { ok: false, reason: "offline" };
    }

    const held =
      !host &&
      command.type === "message" &&
      unhosted.includes(session.status) &&
      this.#hostedGeneration.get(id) !== session.generation;

    if (!held && !host) {
      return { ok: false, reason: "offline" };
    }

    if (
      command.type === "message" &&
      command.requestId !== undefined &&
      !this.#rememberRequest(id, command.requestId)
    ) {
      return { ok: true, value: undefined };
    }

    if (held) {
      this.#held.set(id, [...(this.#held.get(id) ?? []), command]);
    } else {
      host?.send(command);
    }

    return { ok: true, value: undefined };
  }

  #rememberRequest(id: string, requestId: string): boolean {
    const seen = this.#requestIds.get(id) ?? new Set<string>();
    this.#requestIds.set(id, seen);
    if (seen.has(requestId)) {
      return false;
    }

    seen.add(requestId);
    const [oldest] = seen;
    if (seen.size > maxRequestIds && oldest !== undefined) {
      seen.delete(oldest);
    }

    return true;
  }

  attach(
    id: string,
    generation: number,
    send: Listener<Command>,
    end: () => void,
  ): Result<() => void> {
    const current = this.#current(id, generation);
    if (!current.ok) {
      return current;
    }

    const host = { send, end };
    this.#hosts.get(id)?.end();
    this.#hosts.set(id, host);
    this.#hostedGeneration.set(id, generation);

    for (const command of this.#held.get(id) ?? []) {
      send(command);
    }

    this.#held.delete(id);

    return {
      ok: true,
      value: () => {
        if (this.#hosts.get(id) === host) {
          this.#hosts.delete(id);
        }
      },
    };
  }

  transcript(id: string): readonly string[] {
    return this.#store.transcript(id, 0);
  }

  transcriptLength(id: string): number {
    return this.#store.transcriptLength(id);
  }

  isCurrent(id: string, generation: number): boolean {
    return this.#current(id, generation).ok;
  }

  close(): void {
    this.#polls.close();
  }

  #interruptMissing(
    runner: string,
    running: readonly Attempt[],
  ): readonly Attempt[] {
    const now = new Date().toISOString();
    const interrupted: Attempt[] = [];
    for (const session of this.#store.byRunner(runner, attempting)) {
      const alive = running.some(
        (attempt) =>
          attempt.sessionId === session.id &&
          attempt.generation === session.generation,
      );

      if (!alive) {
        this.#hosts.get(session.id)?.end();
        this.#update({ ...session, status: "interrupted", interruptedAt: now });

        interrupted.push({
          sessionId: session.id,
          generation: session.generation,
        });
      }
    }

    return interrupted;
  }

  #stale(running: readonly Attempt[]): readonly Attempt[] {
    return running.filter(
      (attempt) => !this.#current(attempt.sessionId, attempt.generation).ok,
    );
  }

  #removals(runner: {
    readonly name: string;
    readonly environment: string;
  }): readonly Removal[] {
    return this.#store
      .pendingRemovals(runner.environment, runner.name)
      .map(({ id, generation, workspace, workspaceRemoval }) => ({
        sessionId: id,
        generation,
        workspace,
        force: workspaceRemoval === "forced",
      }));
  }

  // A Session loads what its Profile holds at each start (ADR 0031).
  #claimNext(
    runner: { readonly name: string; readonly environment: string },
    capacity: number | undefined,
    running: number,
  ): Assignment[] {
    const free = capacity === undefined ? Infinity : capacity - running;

    const pool = {
      runners: this.#polls.runners(runner.environment),
      leaseLapsed: (name: string) =>
        this.#polls.leaseLapsed(name, runner.environment),
    };

    // A Session still attempting on another runner is claimable only once
    // that runner's lease lapsed.
    const claimable = this.#store
      .byEnvironment(runner.environment, [...claimableStatuses, ...attempting])
      .filter(
        (session) =>
          (claimableStatuses.includes(session.status) ||
            session.runner !== runner.name) &&
          this.#mayTake(session, runner.name, pool),
      )
      .slice(0, Math.max(free, 0));

    return claimable
      .map((session) => this.#moveOff(session))
      .flatMap((next) => {
        let profile: ProfileFiles | undefined;
        try {
          profile = this.profileFiles(next.profileId);
        } catch (error) {
          if (!(error instanceof ProfileTooBig)) {
            throw error;
          }

          this.#update({ ...next, status: "failed", error: error.message });

          return [];
        }

        if (!profile) {
          this.#update({
            ...next,
            status: "failed",
            error: "its Profile no longer exists",
          });

          return [];
        }

        const session: StoredSession = {
          ...next,
          runner: runner.name,
          status: "starting",
          generation: next.generation + 1,
          error: null,
        };

        this.#update(session);

        return {
          sessionId: session.id,
          generation: session.generation,
          trusted: this.#trusted(session),
          profile: { id: session.profileId, hash: profile.hash },
          workspace: session.workspace,
          model: session.model,
          thinking: session.thinking,
          systemPrompt: session.systemPrompt,
          firstMessage: session.firstMessage,
          ...this.#pluginsOf(session),
          environment: this.#sessionEnvironment(session.environmentId),
          ...this.#gitLoginsOf(session.startedBy),
        };
      });
  }

  #pluginsOf(
    session: StoredSession,
  ): Required<
    Pick<Assignment, "plugins" | "pluginSettings" | "requiredPlugins">
  > &
    Pick<Assignment, "installedParts"> {
    const {
      plugins,
      pluginSettings,
      ownSessionsOnly,
      loadOnly,
      installedParts,
    } = this.#sessionPlugins();

    const ownedBy = session.owner?.plugin;
    const limit = ownedBy === undefined ? undefined : loadOnly?.[ownedBy];

    const loaded = plugins.filter(
      (name) =>
        (limit?.includes(name) ?? true) &&
        (ownSessionsOnly?.includes(name) !== true || ownedBy === name),
    );

    const installed = Object.entries(installedParts ?? {}).filter(([name]) =>
      loaded.includes(name),
    );

    return {
      plugins: loaded,
      requiredPlugins: loaded.filter(
        (name) =>
          ownSessionsOnly?.includes(name) === true ||
          installed.some(([each]) => each === name),
      ),
      ...(installed.length > 0 && {
        installedParts: Object.fromEntries(installed),
      }),
      pluginSettings: Object.fromEntries(
        Object.entries(pluginSettings).filter(([name]) =>
          loaded.includes(name),
        ),
      ),
    };
  }

  // A Session another one started, such as a Project's thread, acts for
  // the user who started that one.
  #starter(actor: Actor): string | null {
    const [kind = "", id = ""] = actor.split(/:(.*)/);

    switch (kind) {
      case "user":
        return id;
      case "session":
        return this.#store.get(id)?.startedBy ?? null;
      default:
        return null;
    }
  }

  #gitLoginsOf(userId: string | null): Pick<Assignment, "gitLogins"> {
    const logins = userId === null ? [] : this.#gitLogins(userId);

    return logins.length > 0 ? { gitLogins: logins } : {};
  }

  // What a runner downloads for a Profile (ADR 0041).
  profileFiles(id: string): ProfileFiles | undefined {
    const provided = this.#pluginProfile(id);

    return provided
      ? contentFiles(provided.profile)
      : this.#store.profileFiles(id);
  }

  #profile(id: string): (ProfileContent & { readonly id: string }) | undefined {
    return this.#pluginProfile(id)?.profile ?? this.#store.profile(id);
  }

  #sessionEnvironment(id: string): SessionEnvironment {
    const environment = this.#store
      .environments()
      .find((each) => each.id === id);

    return {
      isolation: environment?.isolation ?? "process",
      image: environment?.image ?? null,
      setupScript: environment?.setupScript ?? "",
      variables: { ...environment?.variables, ...environment?.secrets },
    };
  }

  // A turn running on a runner whose lease lapsed is reported as interrupted,
  // as after an agent restart.
  #moveOff(session: StoredSession): StoredSession {
    if (!attempting.includes(session.status)) {
      return session;
    }

    this.#hosts.get(session.id)?.end();

    const interrupted: StoredSession = {
      ...session,
      status: "interrupted",
      interruptedAt: new Date().toISOString(),
    };

    this.#update(interrupted);

    return interrupted;
  }

  // A command stream whose tunnel died can stay open for minutes, so an
  // offline runner's streams are ended and the agent opens new ones.
  #onlineChanged(runner: string): void {
    const online = this.#polls.online(runner);
    this.#runnersChanged();

    const sessions = this.#store
      .list({ includeArchived: true })
      .filter(
        (session) =>
          session.runner === runner ||
          (session.runner === null &&
            this.#polls
              .runners(session.provider)
              .some(({ name }) => name === runner)),
      );

    for (const session of sessions) {
      if (!online) {
        this.#hosts.get(session.id)?.end();
      }

      this.#emit(session.id, { type: "session", session: this.#view(session) });
    }
  }

  #trackSurface(id: string, generation: number, event: LiveEvent): void {
    const surface = liveSurface(event);
    if (surface === undefined) {
      return;
    }

    let tracked = this.#surfaces.get(id);
    if (tracked?.generation !== generation) {
      tracked = { generation, events: new Map() };
      this.#surfaces.set(id, tracked);
    }

    tracked.events.delete(surface.key);
    if (surface.open) {
      tracked.events.set(surface.key, event);
    }
  }

  #openSurfaces(session: StoredSession): readonly LiveEvent[] {
    const tracked = this.#surfaces.get(session.id);

    return tracked?.generation === session.generation &&
      attempting.includes(session.status)
      ? [...tracked.events.values()]
      : [];
  }

  #current(id: string, generation: number): Result<StoredSession> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (
      session.generation !== generation ||
      !attempting.includes(session.status)
    ) {
      return { ok: false, reason: "stale_generation" };
    }

    return { ok: true, value: session };
  }

  #update(session: StoredSession): void {
    const previous = this.#store.get(session.id)?.status;
    this.#store.update(session);
    if (!attempting.includes(session.status)) {
      this.#surfaces.delete(session.id);
    }

    if (
      ![...claimableStatuses, ...unhosted, ...attempting].includes(
        session.status,
      )
    ) {
      this.#held.delete(session.id);
      this.#hostedGeneration.delete(session.id);
    }

    const view = this.#view(session);
    this.#emit(session.id, { type: "session", session: view });
    if (previous !== undefined && previous !== session.status) {
      this.#events({ type: "SessionStateChanged", session: view, previous });
    }
  }

  // A Session no runner claimed yet is online while its Environment is, and
  // one that ran is online while its runner is still in that Environment.
  #online(session: StoredSession): boolean {
    return this.#polls
      .runners(session.provider)
      .some(
        ({ name, online }) =>
          online && (session.runner === null || session.runner === name),
      );
  }

  #view(session: StoredSession): Session {
    return {
      ...session,
      online: this.#online(session),
      waiting: this.#waiting(session),
    };
  }

  #waiting(session: StoredSession): boolean {
    return this.#openSurfaces(session).some(
      (event) =>
        event.type === "prompt" ||
        (event.type === "pi_view" && event.dialog !== null),
    );
  }

  #emit(id: string, event: SessionEvent): void {
    if (event.type === "session") {
      this.#changed();
    }

    for (const listener of this.#watchers.get(id) ?? []) {
      listener(event);
    }
  }
}

const titleLength = 80;

// Pi's own session name wins; until there is one, the first user message
// names the Session.
function titleAfter(
  title: string | null,
  entries: readonly string[],
): string | null {
  let named = title;

  for (const line of entries) {
    const entry = parsed(line);

    if (entry?.type === "session_info" && typeof entry.name === "string") {
      named = entry.name;
    }

    if (named === null && entry?.type === "message") {
      named = userText(entry.message);
    }
  }

  // Only new names are cut, so a longer title given elsewhere, like a fork's,
  // stays whole.
  return named === null || named === title
    ? named
    : Array.from(named.trim()).slice(0, titleLength).join("");
}

// Pi records each switch, and restores the last one when a session resumes.
function modelAfter(
  model: ModelRef | null,
  entries: readonly string[],
): ModelRef | null {
  let current = model;

  for (const line of entries) {
    const entry = parsed(line);

    if (
      entry?.type === "model_change" &&
      typeof entry.provider === "string" &&
      typeof entry.modelId === "string" &&
      (entry.provider !== current?.provider || entry.modelId !== current.id)
    ) {
      current = { provider: entry.provider, id: entry.modelId };
    }
  }

  return current;
}

function parsed(line: string):
  | {
      type?: unknown;
      name?: unknown;
      message?: unknown;
      provider?: unknown;
      modelId?: unknown;
    }
  | undefined {
  try {
    const value: unknown = JSON.parse(line);

    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

function userText(message: unknown): string | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }

  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "user") {
    return null;
  }

  if (typeof content === "string") {
    return content;
  }

  const text = Array.isArray(content)
    ? (content as { type?: unknown; text?: unknown }[]).find(
        (part) => part.type === "text" && typeof part.text === "string",
      )?.text
    : undefined;

  return typeof text === "string" && text.trim() !== "" ? text : null;
}

// A Session that never started has no branch yet, so its fork starts where
// it would have. An archived one's branch lives on only at its restore point.
function forkedWorkspace({
  workspace,
  generation,
}: StoredSession): WorkspaceRequest {
  if (workspace.kind === "folder") {
    return workspace;
  }

  if (workspace.kind === "repositories") {
    return {
      kind: "repositories",
      repositories: workspace.repositories.map((checkout) => {
        const startPoint =
          generation === 0
            ? checkout.startPoint
            : (checkout.restorePoint ?? workspace.branch);

        return {
          repository: checkout.repository,
          ...(startPoint !== undefined && { startPoint }),
        };
      }),
    };
  }

  const startPoint =
    generation === 0
      ? workspace.startPoint
      : (workspace.restorePoint ?? workspace.branch);

  return workspace.kind === "worktree"
    ? {
        kind: "worktree",
        path: workspace.path,
        ...(startPoint !== undefined && { startPoint }),
      }
    : {
        kind: "clone",
        repository: workspace.repository,
        ...(startPoint !== undefined && { startPoint }),
      };
}
