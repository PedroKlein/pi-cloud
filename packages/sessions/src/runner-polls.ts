import type { WorkPoll } from "@pipoca/protocol";

type Inventory = Pick<WorkPoll, "folders" | "models" | "session">;

export interface PolledRunner {
  readonly name: string;
  readonly environment: string;
  readonly online: boolean;
  readonly capacity: number | null;
  readonly inventory: Inventory;
}

interface RunnerState {
  readonly name: string;
  readonly environment: string;
  capacity: number | null;
  polling: number;
  lastPoll: number;
  offlineTimer: ReturnType<typeof setTimeout> | undefined;
  inventory: Inventory;
}

// A runner stays online for offlineAfterMs after its last poll ends, so the
// gap between long polls doesn't flip it offline. Its lease on its Sessions
// lasts leaseMs after that poll (ADR 0032). A runner is known by its name
// within its Environment, so runners with one name in two Environments are
// two runners.
export class RunnerPolls {
  readonly #pollWaitMs: number;
  readonly #offlineAfterMs: number;
  readonly #leaseMs: number;
  readonly #startedAt = Date.now();
  readonly #onlineChanged: (environment: string, runner: string) => void;
  readonly #runners = new Map<string, RunnerState>();
  readonly #waiting = new Map<string, Set<() => void>>();

  constructor(options: {
    readonly pollWaitMs: number;
    readonly offlineAfterMs: number;
    readonly leaseMs: number;
    readonly onlineChanged: (environment: string, runner: string) => void;
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
    const { environment } = poll;
    const wasOnline = this.online(environment, runner);

    const state = this.#runners.get(key(environment, runner)) ?? {
      ...poll,
      name: runner,
      polling: 0,
      lastPoll: 0,
      offlineTimer: undefined,
    };

    this.#runners.set(key(environment, runner), state);
    state.polling++;
    state.capacity = poll.capacity;
    state.inventory = poll.inventory;
    clearTimeout(state.offlineTimer);
    if (!wasOnline) {
      this.#onlineChanged(environment, runner);
    }

    return () => {
      state.polling--;
      state.lastPoll = Date.now();
      if (state.polling > 0) {
        return;
      }

      state.offlineTimer = setTimeout(() => {
        this.#onlineChanged(environment, runner);
      }, this.#offlineAfterMs);
    };
  }

  online(environment: string, runner: string): boolean {
    const state = this.#runners.get(key(environment, runner));

    return (
      state !== undefined &&
      (state.polling > 0 || Date.now() - state.lastPoll < this.#offlineAfterMs)
    );
  }

  // A runner that hasn't polled since the server started keeps its lease for
  // a full lease after the start, so a restart doesn't move its Sessions.
  leaseLapsed(environment: string, runner: string): boolean {
    const state = this.#runners.get(key(environment, runner));
    if (state === undefined) {
      return Date.now() - this.#startedAt >= this.#leaseMs;
    }

    return state.polling === 0 && Date.now() - state.lastPoll >= this.#leaseMs;
  }

  // The runners that polled for the Environment since the server started.
  runners(environment: string): readonly PolledRunner[] {
    return [...this.#runners.values()]
      .filter((state) => state.environment === environment)
      .map(({ name, capacity, inventory }) => ({
        name,
        environment,
        online: this.online(environment, name),
        capacity,
        inventory,
      }));
  }

  async waitForWork(
    environment: string,
    runner: string,
    signal: AbortSignal,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      const waiting = this.#waiting.get(key(environment, runner)) ?? new Set();
      this.#waiting.set(key(environment, runner), waiting);

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
      for (const done of this.#waiting.get(key(environment, name)) ?? []) {
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

function key(environment: string, runner: string): string {
  return JSON.stringify([environment, runner]);
}
