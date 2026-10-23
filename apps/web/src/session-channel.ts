import type { MountedSession } from "@pi-cloud/plugins/web";
import { liveSurface, type SessionEvent } from "@pi-cloud/protocol";
import { command } from "./api";

// The Session view hands every event it receives to dispatch, so plugins
// share its stream instead of opening their own.
export function sessionChannel(id: string): {
  readonly session: MountedSession;
  readonly dispatch: (event: SessionEvent) => void;
} {
  const listeners = new Set<(event: SessionEvent) => void>();

  // A part that mounts late, or again after it failed, first gets what a new
  // stream would replay: the Session, its entries and its open surfaces.
  let latest: SessionEvent | undefined;
  const entries: SessionEvent[] = [];
  const surfaces = new Map<string, SessionEvent>();

  // A plugin's bug stays its own: the chat and the other plugins still get
  // the event.
  const deliver = (
    listener: (event: SessionEvent) => void,
    event: SessionEvent,
  ): void => {
    try {
      listener(event);
    } catch (error) {
      reportError(error);
    }
  };

  const remember = (event: SessionEvent): void => {
    if (event.type === "session") {
      latest = event;
    } else if (event.type === "entry") {
      entries.push(event);
    } else {
      const surface = liveSurface(event.event);
      if (surface) {
        surfaces.delete(surface.key);
        if (surface.open) {
          surfaces.set(surface.key, event);
        }
      }
    }
  };

  return {
    session: {
      id,
      events: (listener) => {
        const replay = [
          ...(latest ? [latest] : []),
          ...entries,
          ...surfaces.values(),
        ];

        for (const event of replay) {
          deliver(listener, event);
        }

        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
      send: async (text) =>
        command(id, {
          type: "message",
          text,
          requestId: crypto.randomUUID(),
          delivery: "steer",
        }),
    },
    dispatch: (event) => {
      remember(event);

      listeners.forEach((listener) => {
        deliver(listener, event);
      });
    },
  };
}
