import type { WorkPoll } from "@pi-cloud/protocol";

type Inventory = Pick<WorkPoll, "folders" | "models">;

export interface PolledRunner {
  readonly name: string;
  readonly environment: string;
  readonly online: boolean;
  readonly capacity: number | null;
  readonly inventory: Inventory;
}

interface RunnerState {
  environment: string;
  capacity: number | null;
  polling: number;
  lastPoll: number;
  offlineTimer: ReturnType<typeof setTimeout> | undefined;
  inventory: Inventory;
}

// A runner stays online for offlineAfterMs after its last poll ends, so the
// gap between long polls doesn't flip it offline. Its lease on its Sessions
// lasts leaseMs after that poll (ADR 0032).
export class RunnerPolls {
  readonly #pollWaitMs: number;
  readonly #offlineAfterMs: number;
  readonly #leaseMs: number;
  readonly #startedAt = Date.now();
  readonly #onlineChanged: (runner: string) => void;
  readonly #runners = new Map<string, RunnerState>();
  readonly #waiting = new Map<string, Set<() => void>>();

  constructor(options: {
    readonly pollWaitMs: number;
    readonly offlineAfterMs: number;
    readonly leaseMs: number;
    readonly onlineChanged: (runner: string) => void;
  }) {
    this.#pollWaitMs = options.pollWaitMs;
    this.#offlineAfterMs = options.offlineAfterMs;
    this.#leaseMs = options.leaseMs;
    this.#onlineChanged = options.onlineChanged;
  }

  begin(
    runner: string,
    poll: {
      readonly environment: string;
      readonly capacity: number | null;
      readonly inventory: Inventory;
    },
  ): () => void {
    const wasOnline = this.online(runner);

    const state = this.#runners.get(runner) ?? {
      ...poll,
      polling: 0,
      lastPoll: 0,
      offlineTimer: undefined,
    };

    this.#runners.set(runner, state);
    state.polling++;
    state.environment = poll.environment;
    state.capacity = poll.capacity;
    state.inventory = poll.inventory;
    clearTimeout(state.offlineTimer);
    if (!wasOnline) {
      this.#onlineChanged(runner);
    }

    return () => {
      state.polling--;
      state.lastPoll = Date.now();
      if (state.polling > 0) {
        return;
      }

      state.offlineTimer = setTimeout(() => {
        this.#onlineChanged(runner);
      }, this.#offlineAfterMs);
    };
  }

  online(runner: string): boolean {
    const state = this.#runners.get(runner);

    return (
      state !== undefined &&
      (state.polling > 0 || Date.now() - state.lastPoll < this.#offlineAfterMs)
    );
  }

  // A runner that hasn't polled since the server started keeps its lease for
  // a full lease after the start, so a restart doesn't move its Sessions. One
  // that now polls for another Environment holds no lease in this one.
  leaseLapsed(runner: string, environment: string): boolean {
    const state = this.#runners.get(runner);
    if (state === undefined) {
      return Date.now() - this.#startedAt >= this.#leaseMs;
    }

    return (
      state.environment !== environment ||
      (state.polling === 0 && Date.now() - state.lastPoll >= this.#leaseMs)
    );
  }

  // The runners that polled for the Environment since the server started.
  runners(environment: string): readonly PolledRunner[] {
    return [...this.#runners]
      .filter(([, state]) => state.environment === environment)
      .map(([name, state]) => ({
        name,
        environment,
        online: this.online(name),
        capacity: state.capacity,
        inventory: state.inventory,
      }));
  }

  async waitForWork(runner: string, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const waiting = this.#waiting.get(runner) ?? new Set();
      this.#waiting.set(runner, waiting);

      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        waiting.delete(done);
        resolve();
      };

      const timer = setTimeout(done, this.#pollWaitMs);
      signal.addEventListener("abort", done);
      waiting.add(done);
    });
  }

  wake(environment: string): void {
    for (const { name } of this.runners(environment)) {
      for (const done of this.#waiting.get(name) ?? []) {
        done();
      }
    }
  }

  close(): void {
    for (const state of this.#runners.values()) {
      clearTimeout(state.offlineTimer);
    }
  }
}
