import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { type TerminalControl, terminalTakenOver } from "@pipoca/protocol";
import type { Log } from "@pipoca/providers";
import type { Sessions } from "@pipoca/sessions";
import type { Auth } from "./auth";
import {
  fromSessionHost,
  type SocketHandler,
  type SocketServer,
  type TerminalData,
} from "./sockets";

type Socket = ServerWebSocket<TerminalData>;

interface Pair {
  browser?: Socket;
  host?: Socket;
  readonly pending: (string | Buffer)[];
  readonly timeout: ReturnType<typeof setTimeout>;
}

const hostTimeoutMs = 10_000;

// A browser this far behind is closed instead of buffered without bound. The
// shell keeps running, and opening the terminal again replays its last output.
const maxBufferedBytes = 1024 * 1024;
const browserPath = /^\/api\/sessions\/([^/]+)\/terminal$/;
const terminalIdPattern = /^[\w-]{1,64}$/;
const hostPath = /^\/agent\/sessions\/([^/]+)\/terminals\/([^/]+)$/;

export function terminalBroker(
  sessions: Sessions,
  auth: Auth,
  log: Log,
): {
  readonly upgrade: (
    request: Request,
    server: SocketServer,
  ) => Response | "upgraded" | undefined;
  readonly websocket: SocketHandler<TerminalData>;
} {
  const pairs = new Map<string, Pair>();

  const end = (key: string, reason: string): void => {
    const pair = pairs.get(key);
    if (!pair) {
      return;
    }

    pairs.delete(key);
    clearTimeout(pair.timeout);
    pair.browser?.close(1000, reason);
    pair.host?.close(1000, reason);
    log("terminal closed", { terminal: key, reason });
  };

  const openBrowser = (
    request: Request,
    server: SocketServer,
    sessionId: string,
  ): Response | "upgraded" => {
    const user = auth.userOf(request);
    if (user === undefined) {
      return Response.json({ error: "signed_out" }, { status: 401 });
    }

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "expected a websocket" }, { status: 400 });
    }

    const url = new URL(request.url);
    const asked = url.searchParams.get("terminal");

    const terminalId =
      asked !== null && terminalIdPattern.test(asked) ? asked : randomUUID();

    const sent = sessions.send(sessionId, {
      actor: `user:${user.id}`,
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

    // Terminal ids are per Session.
    const key = `${sessionId}/${terminalId}`;
    end(key, terminalTakenOver);

    pairs.set(key, {
      pending: [],
      timeout: setTimeout(() => {
        end(key, "session host did not open the terminal");
      }, hostTimeoutMs),
    });

    log("terminal requested", { sessionId, terminalId });
    if (
      server.upgrade(request, {
        data: { kind: "terminal", role: "browser", key },
      })
    ) {
      return "upgraded";
    }

    end(key, "browser upgrade failed");

    return Response.json({ error: "expected a websocket" }, { status: 400 });
  };

  const openHost = (
    request: Request,
    server: SocketServer,
    sessionId: string,
    terminalId: string,
  ): Response | "upgraded" => {
    const key = `${sessionId}/${terminalId}`;
    const pair = pairs.get(key);
    if (
      pair === undefined ||
      pair.host !== undefined ||
      !fromSessionHost(request, sessions, auth, sessionId)
    ) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return server.upgrade(request, {
      data: { kind: "terminal", role: "host", key },
    })
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
        const pair = pairs.get(ws.data.key);
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
        const pair = pairs.get(ws.data.key);
        if (pair?.browser !== ws && pair?.host !== ws) {
          return;
        }

        if (ws.data.role === "host") {
          const { browser } = pair;
          if ((browser?.getBufferedAmount() ?? 0) > maxBufferedBytes) {
            end(ws.data.key, "browser fell behind");
            browser?.terminate();

            return;
          }

          browser?.send(message);

          return;
        }

        const forward =
          typeof message === "string" ? control(message) : message;

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
        const pair = pairs.get(ws.data.key);
        if (pair?.browser === ws || pair?.host === ws) {
          end(ws.data.key, `${ws.data.role} disconnected`);
        }
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

function control(message: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }

  const { type, cols, rows } = (parsed ?? {}) as Record<string, unknown>;
  if (type === "close") {
    return JSON.stringify({ type } satisfies TerminalControl);
  }

  if (type !== "resize" || !validSize(cols) || !validSize(rows)) {
    return undefined;
  }

  return JSON.stringify({ type, cols, rows } satisfies TerminalControl);
}
