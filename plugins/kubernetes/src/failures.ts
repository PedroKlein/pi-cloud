import type { PodFailure } from "./settings";

export interface FailedPod {
  // What the pod was started for: its Environment's shared pods, or one
  // Session's own pod, which backs off alone.
  readonly key: string;
  readonly environmentId: string;
  readonly pod: string;
  readonly problem: string;
}

const mostDoublings = 5;

// Runner pods that failed in a row. The next pod for the same key waits,
// twice as long after each failed pass, and a quiet spell starts over.
export class PodFailures {
  readonly #retryAfterMs: number;
  readonly #byKey = new Map<
    string,
    {
      readonly environmentId: string;
      readonly count: number;
      readonly last: PodFailure;
    }
  >();

  constructor(retryAfterMs: number) {
    this.#retryAfterMs = retryAfterMs;
  }

  // One pass's failures: pods of one key failing together count once.
  record(failed: readonly FailedPod[], now: number): void {
    const keys = new Map(failed.map((each) => [each.key, each]));

    for (const { key, environmentId, pod, problem } of keys.values()) {
      const previous = this.#byKey.get(key);

      const quiet =
        previous === undefined ||
        now - Date.parse(previous.last.retryAt) >
          this.#retryAfterMs * 2 ** mostDoublings;

      const count = quiet ? 1 : previous.count + 1;

      const waitMs =
        this.#retryAfterMs * 2 ** Math.min(count - 1, mostDoublings);

      this.#byKey.set(key, {
        environmentId,
        count,
        last: {
          pod,
          problem,
          at: new Date(now).toISOString(),
          retryAt: new Date(now + waitMs).toISOString(),
        },
      });
    }
  }

  waiting(key: string, now: number): boolean {
    const retryAt = this.#byKey.get(key)?.last.retryAt;

    return retryAt !== undefined && Date.parse(retryAt) > now;
  }

  clear(key: string): void {
    this.#byKey.delete(key);
  }

  // New settings may well fix what failed.
  clearEnvironment(environmentId: string): void {
    for (const [key, { environmentId: id }] of this.#byKey) {
      if (id === environmentId) {
        this.#byKey.delete(key);
      }
    }
  }

  last(environmentId: string): PodFailure | null {
    return (
      [...this.#byKey.values()]
        .filter(({ environmentId: id }) => id === environmentId)
        .map(({ last }) => last)
        .sort((a, b) => b.at.localeCompare(a.at))[0] ?? null
    );
  }
}
