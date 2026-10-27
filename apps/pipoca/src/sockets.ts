import type { Server, ServerWebSocket } from "bun";
import { protocolVersion, versionHeader } from "@pipoca/protocol";
import type { Sessions } from "@pipoca/sessions";
import type { Auth } from "./auth";

// The server's WebSockets: terminals, keyed by Session and terminal id, and
// the Session host's end of a preview request.
export type SocketData = TerminalData | PreviewData;

export interface TerminalData {
  readonly kind: "terminal";
  readonly role: "browser" | "host";
  readonly key: string;
}

export interface PreviewData {
  readonly kind: "preview";
  readonly role: "browser" | "host";
  readonly connectionId: string;
}

export type SocketServer = Server<SocketData>;

export interface SocketHandler<Data> {
  readonly open: (ws: ServerWebSocket<Data>) => void;
  readonly message: (
    ws: ServerWebSocket<Data>,
    message: string | Buffer,
  ) => void;
  readonly close: (
    ws: ServerWebSocket<Data>,
    code: number,
    reason: string,
  ) => void;
}

// Whether a socket opened under /agent/ comes from the Session host of the
// Session's current attempt.
export function fromSessionHost(
  request: Request,
  sessions: Sessions,
  auth: Auth,
  sessionId: string,
): boolean {
  const generation = Number(
    new URL(request.url).searchParams.get("generation"),
  );

  const caller = auth.agentOf(request);
  const session = sessions.get(sessionId);

  return (
    request.headers.get(versionHeader) === String(protocolVersion) &&
    caller !== undefined &&
    (caller.sessionId === null || caller.sessionId === sessionId) &&
    session?.runner === caller.runner &&
    session.provider === caller.environment &&
    sessions.isCurrent(sessionId, generation)
  );
}
