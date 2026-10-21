import type { Command } from "@pi-cloud/protocol";

// The server adds the actor to everything a browser sends.
export type BrowserCommand = Command extends infer C
  ? C extends Command
    ? Omit<C, "actor">
    : never
  : never;

export async function api(path: string, body?: unknown): Promise<Response> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    ...(body !== undefined && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });

  if (!response.ok) {
    const { error } = (await response.json()) as { error: string };
    throw new Error(error);
  }

  return response;
}

export async function command(
  sessionId: string,
  body: BrowserCommand,
): Promise<void> {
  await api(`/api/sessions/${encodeURIComponent(sessionId)}/commands`, body);
}
