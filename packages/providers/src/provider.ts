import { setTimeout as sleep } from "node:timers/promises";
import type { Assignment, Work } from "@pi-cloud/protocol";

export interface ControlPlane {
  work: (signal: AbortSignal) => Promise<Work>;
}

export type Log = (
  message: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

export interface ProviderOptions {
  readonly controlPlane: ControlPlane;
  readonly start: (assignment: Assignment) => void;
  readonly log: Log;
  readonly signal: AbortSignal;
  readonly retry?: { readonly initialMs: number; readonly maxMs: number };
}

export async function runProvider(options: ProviderOptions): Promise<void> {
  const { controlPlane, start, log, signal } = options;
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
      const work = await controlPlane.work(signal);
      polls++;
      delayMs = initialMs;
      for (const assignment of work.start) {
        started++;
        log("starting session", { ...assignment, started });
        start(assignment);
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
  log("provider stopped", { polls, started });
}
