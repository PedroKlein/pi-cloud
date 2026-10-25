import { setTimeout as sleep } from "node:timers/promises";
import {
  type SessionStart,
  type Attempt,
  leaseMs,
  type ModelRef,
  movable,
  type Removal,
  type Work,
  type WorkPoll,
  type Workspace,
} from "@pi-cloud/protocol";

export interface ControlPlane {
  work: (poll: WorkPoll, signal: AbortSignal) => Promise<Work>;
}

export type Log = (
  message: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

export interface ProviderOptions {
  readonly controlPlane: ControlPlane;
  readonly start: (assignment: SessionStart) => void;
  readonly unload: (attempt: Attempt) => void;
  readonly remove: (removal: Removal) => void;
  // Every Profile that still exists, after each poll.
  readonly profiles: (ids: readonly string[]) => void;
  readonly running: () => readonly Attempt[];
  readonly folders: readonly string[];
  readonly capacity?: number;
  readonly models: () => readonly ModelRef[];
  readonly log: Log;
  readonly signal: AbortSignal;
  readonly retry?: { readonly initialMs: number; readonly maxMs: number };
  readonly leaseMs?: number;
}

export async function runProvider(options: ProviderOptions): Promise<void> {
  const {
    controlPlane,
    start,
    unload,
    remove,
    profiles,
    running,
    folders,
    models,
    log,
    signal,
  } = options;

  const { initialMs, maxMs } = options.retry ?? {
    initialMs: 1000,
    maxMs: 20_000,
  };

  const workspaces = new Map<string, Workspace>();

  // Half the server's lease, so these Sessions stop before the server can
  // start them on another runner (ADR 0032).
  const stopMovableAfterMs = (options.leaseMs ?? leaseMs) / 2;

  const stopMovable = (): void => {
    for (const attempt of running()) {
      const workspace = workspaces.get(attempt.sessionId);
      if (workspace !== undefined && movable(workspace)) {
        log("stopping session after losing its lease", { ...attempt });
        unload(attempt);
      }
    }
  };

  let leaseTimer = setTimeout(stopMovable, stopMovableAfterMs);
  let delayMs = initialMs;
  let polls = 0;
  let started = 0;
  log("provider polling for work");
  while (!signal.aborted) {
    try {
      const work = await controlPlane.work(
        {
          running: running(),
          folders,
          models: models(),
          ...(options.capacity !== undefined && {
            capacity: options.capacity,
          }),
        },
        signal,
      );

      polls++;
      delayMs = initialMs;
      clearTimeout(leaseTimer);
      leaseTimer = setTimeout(stopMovable, stopMovableAfterMs);

      const live = new Set(running().map(({ sessionId }) => sessionId));
      for (const sessionId of workspaces.keys()) {
        if (!live.has(sessionId)) {
          workspaces.delete(sessionId);
        }
      }

      for (const assignment of work.start) {
        started++;
        workspaces.set(assignment.sessionId, assignment.workspace);
        const { environment: _secret, ...logged } = assignment;
        log("starting session", { ...logged, started });
        start(assignment);
      }

      for (const attempt of work.unload) {
        log("unloading session", { ...attempt });
        unload(attempt);
      }

      work.remove.forEach(remove);
      // An older server sends none, which mustn't read as every Profile gone.
      if (Array.isArray(work.profiles)) {
        profiles(work.profiles);
      }
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the signal can abort while the await above is pending
      if (signal.aborted) {
        break;
      }

      log("work poll failed", { error: String(error), retryInMs: delayMs });
      await sleep(delayMs, undefined, { signal }).catch(() => undefined);
      delayMs = Math.min(delayMs * 2, maxMs);
    }
  }

  clearTimeout(leaseTimer);
  log("provider stopped", { polls, started });
}
