import { setTimeout as sleep } from "node:timers/promises";
import type {
  Assignment,
  Attempt,
  ModelRef,
  Removal,
  Work,
  WorkPoll,
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
  readonly start: (assignment: Assignment) => void;
  readonly unload: (attempt: Attempt) => void;
  readonly remove: (removal: Removal) => void;
  readonly running: () => readonly Attempt[];
  readonly folders: readonly string[];
  readonly models: () => readonly ModelRef[];
  readonly log: Log;
  readonly signal: AbortSignal;
  readonly retry?: { readonly initialMs: number; readonly maxMs: number };
}

export async function runProvider(options: ProviderOptions): Promise<void> {
  const {
    controlPlane,
    start,
    unload,
    remove,
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

  let delayMs = initialMs;
  let polls = 0;
  let started = 0;
  log("provider polling for work");
  while (!signal.aborted) {
    try {
      const work = await controlPlane.work(
        { running: running(), folders, models: models() },
        signal,
      );

      polls++;
      delayMs = initialMs;
      for (const assignment of work.start) {
        started++;
        log("starting session", { ...assignment, started });
        start(assignment);
      }

      for (const attempt of work.unload) {
        log("unloading session", { ...attempt });
        unload(attempt);
      }

      work.remove.forEach(remove);
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

  log("provider stopped", { polls, started });
}
