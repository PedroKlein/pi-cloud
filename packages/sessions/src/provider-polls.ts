import type { WorkPoll } from "@pi-cloud/protocol";

type Inventory = Pick<WorkPoll, "folders" | "models">;

interface ProviderState {
  polling: number;
  lastPoll: number;
  offlineTimer: ReturnType<typeof setTimeout> | undefined;
  inventory: Inventory;
}

// A provider stays online for offlineAfterMs after its last poll ends, so the
// gap between long polls doesn't flip it offline.
export class ProviderPolls {
  readonly #pollWaitMs: number;
  readonly #offlineAfterMs: number;
  readonly #onlineChanged: (provider: string) => void;
  readonly #providers = new Map<string, ProviderState>();
  readonly #waiting = new Map<string, Set<() => void>>();

  constructor(options: {
    readonly pollWaitMs: number;
    readonly offlineAfterMs: number;
    readonly onlineChanged: (provider: string) => void;
  }) {
    this.#pollWaitMs = options.pollWaitMs;
    this.#offlineAfterMs = options.offlineAfterMs;
    this.#onlineChanged = options.onlineChanged;
  }

  begin(provider: string, inventory: Inventory): () => void {
    const wasOnline = this.online(provider);

    const state = this.#providers.get(provider) ?? {
      polling: 0,
      lastPoll: 0,
      offlineTimer: undefined,
      inventory,
    };

    this.#providers.set(provider, state);
    state.polling++;
    state.inventory = inventory;
    clearTimeout(state.offlineTimer);
    if (!wasOnline) {
      this.#onlineChanged(provider);
    }

    return () => {
      state.polling--;
      state.lastPoll = Date.now();
      if (state.polling > 0) {
        return;
      }

      state.offlineTimer = setTimeout(() => {
        this.#onlineChanged(provider);
      }, this.#offlineAfterMs);
    };
  }

  online(provider: string): boolean {
    const state = this.#providers.get(provider);

    return (
      state !== undefined &&
      (state.polling > 0 || Date.now() - state.lastPoll < this.#offlineAfterMs)
    );
  }

  inventory(provider: string): Inventory {
    return (
      this.#providers.get(provider)?.inventory ?? { folders: [], models: [] }
    );
  }

  async waitForWork(provider: string, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const waiting = this.#waiting.get(provider) ?? new Set();
      this.#waiting.set(provider, waiting);

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

  wake(provider: string): void {
    for (const done of this.#waiting.get(provider) ?? []) {
      done();
    }
  }

  close(): void {
    for (const state of this.#providers.values()) {
      clearTimeout(state.offlineTimer);
    }
  }
}
