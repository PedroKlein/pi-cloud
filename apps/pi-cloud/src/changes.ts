import { sseResponse } from "./sse";

// Tells open pages that something of a kind changed, never what, so each
// fetches it as usual (ADR 0038).
export interface Changes {
  readonly publish: (topic: string) => void;
  readonly stream: () => Response;
}

export function changeFeed(): Changes {
  const listeners = new Set<(topic: string) => void>();

  return {
    publish: (topic) => {
      for (const listener of listeners) {
        listener(topic);
      }
    },
    stream: () =>
      sseResponse((send) => {
        const listener = (topic: string): void => {
          send({ topic });
        };

        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      }),
  };
}

const kernelTopics: readonly (readonly [RegExp, string])[] = [
  [/^\/api\/profiles(\/|$)/, "profiles"],
  [/^\/api\/environments(\/|$)/, "environments"],
  [/^\/api\/mcp-tokens(\/|$)/, "mcp-tokens"],
  [
    /^\/api\/(plugins(\/[^/]+)?|plugin-files\/.*|plugin-builds\/.*)$/,
    "plugins",
  ],
];

// The kernel list a successful write to this path changes. Sessions tell
// on their own, since they also change without a request.
export function changedBy(
  request: Request,
  response: Response,
): string | undefined {
  if (request.method === "GET" || !response.ok) {
    return undefined;
  }

  const { pathname } = new URL(request.url);

  return kernelTopics.find(([pattern]) => pattern.test(pathname))?.[1];
}
