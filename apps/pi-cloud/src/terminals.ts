import { randomUUID } from "node:crypto";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import {
  protocolVersion,
  providerHeader,
  versionHeader,
} from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";
import type { Sessions } from "@pi-cloud/sessions";

interface SocketData {
  readonly role: "browser" | "host";
  readonly terminalId: string;
}

interface Pair {
  browser?: ServerWebSocket<SocketData>;
  host?: ServerWebSocket<SocketData>;
  readonly pending: (string | Buffer)[];
  readonly timeout: ReturnType<typeof setTimeout>;
}

const hostTimeoutMs = 10_000;
const browserPath = /^\/api\/sessions\/([^/]+)\/terminal$/;
const hostPath = /^\/agent\/sessions\/([^/]+)\/terminals\/([^/]+)$/;

export function terminalBroker(
  sessions: Sessions,
  log: Log,
): {
  readonly upgrade: (
    request: Request,
    server: Server<SocketData>,
  ) => Response | "upgraded" | undefined;
  readonly websocket: WebSocketHandler<SocketData>;
} {
  const pairs = new Map<string, Pair>();

  const end = (terminalId: string, reason: string): void => {
    const pair = pairs.get(terminalId);
    if (!pair) {
      return;
    }
    pairs.delete(terminalId);
    clearTimeout(pair.timeout);
    pair.browser?.close(1000, reason);
    pair.host?.close(1000, reason);
    log("terminal closed", { terminalId, reason });
  };

  const openBrowser = (
    request: Request,
    server: Server<SocketData>,
    sessionId: string,
  ): Response | "upgraded" => {
    const url = new URL(request.url);
    const terminalId = randomUUID();
    const sent = sessions.send(sessionId, {
      type: "terminal",
      terminalId,
      cols: Number(url.searchParams.get("cols") ?? 80),
      rows: Number(url.searchParams.get("rows") ?? 24),
    });
    if (!sent.ok) {
      return Response.json(
        { error: sent.reason },
        { status: sent.reason === "not_found" ? 404 : 409 },
      );
    }
    pairs.set(terminalId, {
      pending: [],
      timeout: setTimeout(() => {
        end(terminalId, "session host did not open the terminal");
      }, hostTimeoutMs),
    });
    log("terminal requested", { sessionId, terminalId });
    return server.upgrade(request, { data: { role: "browser", terminalId } })
      ? "upgraded"
      : Response.json({ error: "expected a websocket" }, { status: 400 });
  };

  const openHost = (
    request: Request,
    server: Server<SocketData>,
    sessionId: string,
    terminalId: string,
  ): Response | "upgraded" => {
    const generation = Number(
      new URL(request.url).searchParams.get("generation"),
    );
    const provider = request.headers.get(providerHeader);
    if (
      request.headers.get(versionHeader) !== String(protocolVersion) ||
      sessions.get(sessionId)?.provider !== provider ||
      !sessions.isCurrent(sessionId, generation) ||
      !pairs.has(terminalId)
    ) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return server.upgrade(request, { data: { role: "host", terminalId } })
      ? "upgraded"
      : Response.json({ error: "expected a websocket" }, { status: 400 });
  };

  return {
    upgrade: (request, server) => {
      const { pathname } = new URL(request.url);
      const browser = browserPath.exec(pathname);
      if (browser) {
        return openBrowser(request, server, browser[1] ?? "");
      }
      const host = hostPath.exec(pathname);
      if (host) {
        return openHost(request, server, host[1] ?? "", host[2] ?? "");
      }
      return undefined;
    },
    websocket: {
      open: (ws) => {
        const pair = pairs.get(ws.data.terminalId);
        if (!pair) {
          ws.close(1000, "terminal closed");
          return;
        }
        if (ws.data.role === "browser") {
          pair.browser = ws;
          return;
        }
        pair.host = ws;
        clearTimeout(pair.timeout);
        for (const message of pair.pending.splice(0)) {
          ws.send(message);
        }
      },
      message: (ws, message) => {
        const pair = pairs.get(ws.data.terminalId);
        if (!pair) {
          return;
        }
        if (ws.data.role === "host") {
          pair.browser?.send(message);
        } else if (pair.host) {
          pair.host.send(message);
        } else {
          pair.pending.push(message);
        }
      },
      close: (ws) => {
        end(ws.data.terminalId, `${ws.data.role} disconnected`);
      },
    },
  };
}
