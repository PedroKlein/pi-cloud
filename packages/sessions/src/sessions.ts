import { randomUUID } from "node:crypto";
import type {
  Assignment,
  Attempt,
  Command,
  CreateSession,
  Environment,
  LiveEvent,
  LivePost,
  ModelRef,
  Removal,
  RemovalReport,
  Session,
  SessionEvent,
  SessionStatus,
  StartFailure,
  TranscriptAck,
  TranscriptBatch,
  WorkPoll,
} from "@pi-cloud/protocol";

export type StoredSession = Omit<Session, "online">;

export type StoredEnvironment = Omit<
  Environment,
  "online" | "folders" | "models"
>;

// v1 has one user, who owns every record (ADR 0015).
export const owner = "local";

export interface SessionStore {
  ensureEnvironment: (provider: string) => void;
  environments: () => readonly StoredEnvironment[];
  insert: (session: StoredSession) => void;
  update: (session: StoredSession) => void;
  get: (id: string) => StoredSession | undefined;
  list: () => readonly StoredSession[];
  byProvider: (
    provider: string,
    statuses: readonly SessionStatus[],
  ) => readonly StoredSession[];
  transcriptLength: (id: string) => number;
  appendTranscript: (
    id: string,
    start: number,
    lines: readonly string[],
  ) => void;
  transcript: (id: string, from: number) => readonly string[];
}

export type Rejection =
  | "not_found"
  | "stale_generation"
  | "offline"
  | "archived"
  | "not_archived"
  | "not_kept"
  | "unknown_environment";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: Rejection };

export interface SessionsOptions {
  readonly pollWaitMs?: number;
  readonly offlineAfterMs?: number;
}

export interface Claim {
  readonly start: readonly Assignment[];
  readonly unload: readonly Attempt[];
  readonly remove: readonly Removal[];
  readonly interrupted: readonly Attempt[];
}

type Listener<T> = (value: T) => void;

interface ProviderState {
  polling: number;
  lastPoll: number;
  offlineTimer: ReturnType<typeof setTimeout> | undefined;
  folders: readonly string[];
  models: readonly ModelRef[];
}

// Enough to catch a browser retrying a send; ids only need to outlive retries.
const maxRequestIds = 100;
const claimable: readonly SessionStatus[] = ["queued", "interrupted"];
const attempting: readonly SessionStatus[] = ["starting", "idle", "running"];

export class Sessions {
  readonly #store: SessionStore;
  readonly #pollWaitMs: number;
  readonly #offlineAfterMs: number;
  readonly #watchers = new Map<string, Set<Listener<SessionEvent>>>();
  readonly #hosts = new Map<
    string,
    { readonly send: Listener<Command>; readonly end: () => void }
  >();
  readonly #pollers = new Map<string, Set<() => void>>();
  readonly #requestIds = new Map<string, Set<string>>();
  readonly #providers = new Map<string, ProviderState>();
  readonly #surfaces = new Map<
    string,
    { readonly generation: number; readonly events: Map<string, LiveEvent> }
  >();

  constructor(store: SessionStore, options: SessionsOptions = {}) {
    this.#store = store;
    this.#pollWaitMs = options.pollWaitMs ?? 10_000;
    this.#offlineAfterMs = options.offlineAfterMs ?? 30_000;
  }

  create(request: CreateSession): Result<Session> {
    const environments = this.#store.environments();

    const environment =
      request.environment === undefined
        ? environments[0]
        : environments.find(({ id }) => id === request.environment);

    if (!environment) {
      return { ok: false, reason: "unknown_environment" };
    }

    const id = randomUUID();

    const session: StoredSession = {
      id,
      environmentId: environment.id,
      ownerId: owner,
      provider: environment.provider,
      workspace:
        request.workspace.kind === "folder"
          ? request.workspace
          : { ...request.workspace, branch: `pi-cloud/${id.slice(0, 8)}` },
      model: request.model ?? null,
      status: "queued",
      generation: 0,
      createdAt: new Date().toISOString(),
      interruptedAt: null,
      error: null,
      archivedAt: null,
      workspaceRemoval: null,
    };

    this.#store.insert(session);
    this.#wake(session.provider);

    return { ok: true, value: this.#view(session) };
  }

  list({ archived = false } = {}): readonly Session[] {
    return this.#store
      .list()
      .filter((session) => archived || session.archivedAt === null)
      .map((session) => this.#view(session));
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
    };

    this.#hosts.get(id)?.end();
    this.#update(archived);
    this.#wake(session.provider);

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

    const unarchived: StoredSession = {
      ...session,
      status: "queued",
      archivedAt: null,
      workspaceRemoval: null,
    };

    this.#update(unarchived);
    this.#wake(session.provider);

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

    const forced: StoredSession = { ...session, workspaceRemoval: "forced" };
    this.#update(forced);
    this.#wake(session.provider);

    return { ok: true, value: this.#view(forced) };
  }

  reportRemoval(id: string, report: RemovalReport): Result<undefined> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (session.archivedAt === null) {
      return { ok: false, reason: "not_archived" };
    }

    const restored =
      report.outcome === "removed" &&
      report.restore !== null &&
      session.workspace.kind !== "folder"
        ? { ...session.workspace, startPoint: report.restore }
        : session.workspace;

    this.#update({
      ...session,
      workspace: restored,
      workspaceRemoval: report.outcome,
    });

    return { ok: true, value: undefined };
  }

  get(id: string): Session | undefined {
    const session = this.#store.get(id);

    return session && this.#view(session);
  }

  environments(): readonly Environment[] {
    return this.#store.environments().map((environment) => {
      const state = this.#providers.get(environment.provider);

      return {
        ...environment,
        online: this.#online(environment.provider),
        folders: state?.folders ?? [],
        models: state?.models ?? [],
      };
    });
  }

  async claim(
    provider: string,
    { running, folders, models }: WorkPoll,
    signal: AbortSignal,
  ): Promise<Claim> {
    this.#store.ensureEnvironment(provider);
    const state = this.#pollStarted(provider);
    state.folders = folders;
    state.models = models;
    try {
      const interrupted = this.#interruptMissing(provider, running);
      const start = this.#claimNext(provider);
      const unload = this.#stale(running);
      if (start.length > 0 || unload.length > 0 || signal.aborted) {
        return { start, unload, remove: this.#removals(provider), interrupted };
      }

      await this.#waitForWork(provider, signal);

      return {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the signal can abort while the wait above is pending
        start: signal.aborted ? [] : this.#claimNext(provider),
        unload: this.#stale(running),
        remove: this.#removals(provider),
        interrupted,
      };
    } finally {
      this.#pollEnded(provider, state);
    }
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
    const current = this.#current(id, batch.generation);
    if (!current.ok) {
      return current;
    }

    const length = this.#store.transcriptLength(id);
    if (batch.start <= length) {
      const fresh = batch.lines.slice(length - batch.start);
      if (fresh.length > 0) {
        this.#store.appendTranscript(id, length, fresh);

        fresh.forEach((entry, i) => {
          this.#emit(id, { type: "entry", line: length + i, entry });
        });
      }
    }

    return {
      ok: true,
      value: { acked: this.#store.transcriptLength(id) },
    };
  }

  publish(id: string, post: LivePost): Result<undefined> {
    const current = this.#current(id, post.generation);
    if (!current.ok) {
      return current;
    }

    let session = current.value;
    for (const event of post.events) {
      if (event.type === "status") {
        session = { ...session, status: event.status };
        this.#update(session);
      }

      this.#trackSurface(id, post.generation, event);

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
        },
      },
    };
  }

  send(id: string, command: Command): Result<undefined> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (session.archivedAt !== null) {
      return { ok: false, reason: "archived" };
    }

    const host = this.#hosts.get(id);
    if (!host) {
      return { ok: false, reason: "offline" };
    }

    if (
      command.type !== "message" ||
      command.requestId === undefined ||
      this.#firstRequest(id, command.requestId)
    ) {
      host.send(command);
    }

    return { ok: true, value: undefined };
  }

  #firstRequest(id: string, requestId: string): boolean {
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

    return {
      ok: true,
      value: () => {
        if (this.#hosts.get(id) === host) {
          this.#hosts.delete(id);
        }
      },
    };
  }

  isCurrent(id: string, generation: number): boolean {
    return this.#current(id, generation).ok;
  }

  close(): void {
    for (const state of this.#providers.values()) {
      clearTimeout(state.offlineTimer);
    }
  }

  #interruptMissing(
    provider: string,
    running: readonly Attempt[],
  ): readonly Attempt[] {
    const now = new Date().toISOString();
    const interrupted: Attempt[] = [];
    for (const session of this.#store.byProvider(provider, attempting)) {
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

  #removals(provider: string): readonly Removal[] {
    return this.#store
      .byProvider(provider, ["stopped"])
      .flatMap(({ id, workspace, workspaceRemoval }) =>
        workspaceRemoval === "pending" || workspaceRemoval === "forced"
          ? [{ sessionId: id, workspace, force: workspaceRemoval === "forced" }]
          : [],
      );
  }

  #wake(provider: string): void {
    for (const wake of this.#pollers.get(provider) ?? []) {
      wake();
    }
  }

  #claimNext(provider: string): Assignment[] {
    return this.#store.byProvider(provider, claimable).map((next) => {
      const session: StoredSession = {
        ...next,
        status: "starting",
        generation: next.generation + 1,
        error: null,
      };

      this.#update(session);

      return {
        sessionId: session.id,
        generation: session.generation,
        workspace: session.workspace,
        model: session.model,
      };
    });
  }

  async #waitForWork(provider: string, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const pollers = this.#pollers.get(provider) ?? new Set();
      this.#pollers.set(provider, pollers);

      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        pollers.delete(done);
        resolve();
      };

      const timer = setTimeout(done, this.#pollWaitMs);
      signal.addEventListener("abort", done);
      pollers.add(done);
    });
  }

  #pollStarted(provider: string): ProviderState {
    const state = this.#providers.get(provider) ?? {
      polling: 0,
      lastPoll: 0,
      offlineTimer: undefined,
      folders: [],
      models: [],
    };

    this.#providers.set(provider, state);
    const wasOnline = this.#online(provider);
    state.polling++;
    clearTimeout(state.offlineTimer);
    if (!wasOnline) {
      this.#emitProvider(provider);
    }

    return state;
  }

  #pollEnded(provider: string, state: ProviderState): void {
    state.polling--;
    state.lastPoll = Date.now();
    if (state.polling > 0) {
      return;
    }

    state.offlineTimer = setTimeout(() => {
      this.#emitProvider(provider);
    }, this.#offlineAfterMs);
  }

  #online(provider: string): boolean {
    const state = this.#providers.get(provider);

    return (
      state !== undefined &&
      (state.polling > 0 || Date.now() - state.lastPoll < this.#offlineAfterMs)
    );
  }

  #emitProvider(provider: string): void {
    const sessions = this.#store
      .list()
      .filter((session) => session.provider === provider);

    for (const session of sessions) {
      this.#emit(session.id, { type: "session", session: this.#view(session) });
    }
  }

  #trackSurface(id: string, generation: number, event: LiveEvent): void {
    const surface = surfaceOf(event);
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
    this.#store.update(session);
    this.#emit(session.id, { type: "session", session: this.#view(session) });
  }

  #view(session: StoredSession): Session {
    return { ...session, online: this.#online(session.provider) };
  }

  #emit(id: string, event: SessionEvent): void {
    for (const listener of this.#watchers.get(id) ?? []) {
      listener(event);
    }
  }
}

function surfaceOf(
  event: LiveEvent,
): { readonly key: string; readonly open: boolean } | undefined {
  switch (event.type) {
    case "prompt":
      return { key: `prompt:${event.prompt.id}`, open: true };
    case "prompt_end":
      return { key: `prompt:${event.id}`, open: false };
    case "extension_status":
      return { key: `status:${event.key}`, open: event.text !== null };
    case "widget":
      return { key: `widget:${event.key}`, open: event.lines !== null };
    case "title":
      return { key: "title", open: true };
    case "changes":
      return { key: "changes", open: true };
    case "queue":
      return {
        key: "queue",
        open: event.steering.length > 0 || event.followUp.length > 0,
      };
    case "status":
    case "notify":
    case "editor_text":
    case "explanation":
    case "text":
    case "tool_start":
    case "tool_end":
      return undefined;
  }
}
