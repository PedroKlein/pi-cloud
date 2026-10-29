import { randomUUID } from "node:crypto";

export interface Locks {
  // A lease once the key is free, or undefined when it stays held past the
  // wait, so the caller can ask again.
  readonly acquire: (key: string) => Promise<string | undefined>;
  readonly holds: (key: string, lease: string) => boolean;
  // False when the lease already lapsed or was never given.
  readonly release: (key: string, lease: string) => boolean;
}

interface Held {
  readonly lease: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

// One holder per key at a time. A holder that never releases, such as a
// runner that went away, loses its lease after holdMs.
export function locks(holdMs: number, waitMs: number): Locks {
  const held = new Map<string, Held>();
  const waiting = new Map<string, ((lease: string) => void)[]>();

  const grant = (key: string): string => {
    const lease = randomUUID();

    const timer = setTimeout(() => {
      free(key, lease);
    }, holdMs);

    timer.unref();

    held.set(key, { lease, timer });

    return lease;
  };

  const free = (key: string, lease: string): boolean => {
    const holder = held.get(key);
    if (holder?.lease !== lease) {
      return false;
    }

    clearTimeout(holder.timer);
    held.delete(key);

    const next = waiting.get(key)?.shift();
    if (waiting.get(key)?.length === 0) {
      waiting.delete(key);
    }

    next?.(grant(key));

    return true;
  };

  return {
    acquire: async (key) => {
      if (!held.has(key)) {
        return grant(key);
      }

      return new Promise((resolve) => {
        const queue = waiting.get(key) ?? [];
        waiting.set(key, queue);

        const timer = setTimeout(() => {
          queue.splice(queue.indexOf(granted), 1);
          if (queue.length === 0) {
            waiting.delete(key);
          }

          resolve(undefined);
        }, waitMs);

        timer.unref();

        const granted = (lease: string): void => {
          clearTimeout(timer);
          resolve(lease);
        };

        queue.push(granted);
      });
    },
    holds: (key, lease) => held.get(key)?.lease === lease,
    release: free,
  };
}
