import { randomUUID } from "node:crypto";
import type {
  Assignment,
  Command,
  CreateSession,
  LivePost,
  Session,
  SessionEvent,
  TranscriptAck,
  TranscriptBatch,
} from "@pi-cloud/protocol";

export interface SessionStore {
  insert: (session: Session) => void;
  update: (session: Session) => void;
  get: (id: string) => Session | undefined;
  list: () => readonly Session[];
  queued: (provider: string) => readonly Session[];
  transcriptLength: (id: string) => number;
  appendTranscript: (
    id: string,
    start: number,
    lines: readonly string[],
  ) => void;
  transcript: (id: string, from: number) => readonly string[];
}

export type Rejection = "not_found" | "stale_generation" | "offline";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: Rejection };

type Listener<T> = (value: T) => void;

export class Sessions {
  readonly #store: SessionStore;
  readonly #watchers = new Map<string, Set<Listener<SessionEvent>>>();
  readonly #hosts = new Map<string, Listener<Command>>();
  readonly #pollers = new Map<string, Set<() => void>>();

  constructor(store: SessionStore) {
    this.#store = store;
  }

  create(request: CreateSession): Session {
    const session: Session = {
      id: randomUUID(),
      provider: request.provider,
      cwd: request.cwd,
      status: "queued",
      generation: 0,
      createdAt: new Date().toISOString(),
    };
    this.#store.insert(session);
    for (const wake of this.#pollers.get(session.provider) ?? []) {
      wake();
    }
    return session;
  }

  list(): readonly Session[] {
    return this.#store.list();
  }

  get(id: string): Session | undefined {
    return this.#store.get(id);
  }

  async claim(
    provider: string,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<readonly Assignment[]> {
    const claimed = this.#claimQueued(provider);
    if (claimed.length > 0 || signal.aborted) {
      return claimed;
    }
    await new Promise<void>((resolve) => {
      const pollers = this.#pollers.get(provider) ?? new Set();
      this.#pollers.set(provider, pollers);
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        pollers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      signal.addEventListener("abort", done);
      pollers.add(done);
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the signal can abort while the wait above is pending
    return signal.aborted ? [] : this.#claimQueued(provider);
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
        this.#store.update(session);
        this.#emit(id, { type: "session", session });
      }
      this.#emit(id, { type: "live", event });
    }
    return { ok: true, value: undefined };
  }

  watch(
    id: string,
    listener: Listener<SessionEvent>,
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
      { type: "session", session },
      ...this.#store
        .transcript(id, 0)
        .map((entry, line): SessionEvent => ({ type: "entry", line, entry })),
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
    if (!this.#store.get(id)) {
      return { ok: false, reason: "not_found" };
    }
    const host = this.#hosts.get(id);
    if (!host) {
      return { ok: false, reason: "offline" };
    }
    host(command);
    return { ok: true, value: undefined };
  }

  attach(
    id: string,
    generation: number,
    listener: Listener<Command>,
  ): Result<() => void> {
    const current = this.#current(id, generation);
    if (!current.ok) {
      return current;
    }
    this.#hosts.set(id, listener);
    return {
      ok: true,
      value: () => {
        if (this.#hosts.get(id) === listener) {
          this.#hosts.delete(id);
        }
      },
    };
  }

  #claimQueued(provider: string): Assignment[] {
    return this.#store.queued(provider).map((queued) => {
      const session: Session = {
        ...queued,
        status: "starting",
        generation: queued.generation + 1,
      };
      this.#store.update(session);
      this.#emit(session.id, { type: "session", session });
      return {
        sessionId: session.id,
        generation: session.generation,
        cwd: session.cwd,
      };
    });
  }

  #current(id: string, generation: number): Result<Session> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }
    if (session.generation !== generation) {
      return { ok: false, reason: "stale_generation" };
    }
    return { ok: true, value: session };
  }

  #emit(id: string, event: SessionEvent): void {
    for (const listener of this.#watchers.get(id) ?? []) {
      listener(event);
    }
  }
}
