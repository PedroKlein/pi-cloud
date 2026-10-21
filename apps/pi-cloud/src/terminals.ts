import { randomUUID } from "node:crypto";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import {
  protocolVersion,
  providerHeader,
  type TerminalResize,
  versionHeader,
} from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";
import { owner, type Sessions } from "@pi-cloud/sessions";

interface SocketData {
  readonly role: "browser" | "host";
  readonly terminalId: string;
}

interface Pair {
  readonly sessionId: string;
  browser?: ServerWebSocket<SocketData>;
  host?: ServerWebSocket<SocketData>;
  readonly pending: (string | Buffer)[];
  readonly timeout: ReturnType<typeof setTimeout>;
}

const hostTimeoutMs = 10_000;

// Terminal output is not replayed, so a browser this far behind is closed
// instead of buffered without bound. The user opens a new terminal.
const maxBufferedBytes = 1024 * 1024;
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
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "expected a websocket" }, { status: 400 });
    }

    const url = new URL(request.url);
    const terminalId = randomUUID();

    const sent = sessions.send(sessionId, {
      actor: `user:${owner}`,
      type: "terminal",
      terminalId,
      cols: size(url.searchParams.get("cols"), 80),
      rows: size(url.searchParams.get("rows"), 24),
    });

    if (!sent.ok) {
      return Response.json(
        { error: sent.reason },
        { status: sent.reason === "not_found" ? 404 : 409 },
      );
    }

    pairs.set(terminalId, {
      sessionId,
      pending: [],
      timeout: setTimeout(() => {
        end(terminalId, "session host did not open the terminal");
      }, hostTimeoutMs),
    });

    log("terminal requested", { sessionId, terminalId });
    if (server.upgrade(request, { data: { role: "browser", terminalId } })) {
      return "upgraded";
    }

    end(terminalId, "browser upgrade failed");

    return Response.json({ error: "expected a websocket" }, { status: 400 });
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
    const pair = pairs.get(terminalId);
    if (
      pair?.sessionId !== sessionId ||
      pair.host !== undefined ||
      request.headers.get(versionHeader) !== String(protocolVersion) ||
      sessions.get(sessionId)?.provider !== provider ||
      !sessions.isCurrent(sessionId, generation)
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
          const { browser } = pair;
          if ((browser?.getBufferedAmount() ?? 0) > maxBufferedBytes) {
            end(ws.data.terminalId, "browser fell behind");
            browser?.terminate();

            return;
          }

          browser?.send(message);

          return;
        }

        const forward = typeof message === "string" ? resize(message) : message;
        if (forward === undefined) {
          return;
        }

        if (pair.host) {
          pair.host.send(forward);
        } else {
          pair.pending.push(forward);
        }
      },
      close: (ws) => {
        end(ws.data.terminalId, `${ws.data.role} disconnected`);
      },
    },
  };
}

const maxSize = 1000;

function validSize(value: unknown): value is number {
  return (
    Number.isInteger(value) && Number(value) > 0 && Number(value) <= maxSize
  );
}

function size(value: string | null, fallback: number): number {
  const parsed = Number(value ?? fallback);

  return validSize(parsed) ? parsed : fallback;
}

function resize(message: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }

  const { type, cols, rows } = (parsed ?? {}) as Record<string, unknown>;
  if (type !== "resize" || !validSize(cols) || !validSize(rows)) {
    return undefined;
  }

  return JSON.stringify({ type, cols, rows } satisfies TerminalResize);
}
