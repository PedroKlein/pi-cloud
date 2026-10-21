import type { KernelEvent, PluginEvent } from "./plugin";

type AnyEvent = KernelEvent | PluginEvent;

type EventOf<T extends string> = T extends KernelEvent["type"]
  ? Extract<KernelEvent, { type: T }>
  : PluginEvent;

export interface EventBus {
  readonly publish: (event: AnyEvent) => void;
  readonly subscribe: <T extends AnyEvent["type"]>(
    type: T,
    listener: (event: EventOf<T>) => void,
  ) => () => void;
}

export function eventBus(
  onError: (type: string, error: unknown) => void,
): EventBus {
  const listeners = new Map<string, Set<(event: AnyEvent) => void>>();

  return {
    publish: (event) => {
      for (const listener of listeners.get(event.type) ?? []) {
        try {
          listener(event);
        } catch (error) {
          onError(event.type, error);
        }
      }
    },
    subscribe: (type, listener) => {
      const forType = listeners.get(type) ?? new Set();
      listeners.set(type, forType);
      const wrapped = listener as (event: AnyEvent) => void;
      forType.add(wrapped);

      return () => {
        forType.delete(wrapped);
      };
    },
  };
}
