import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { ServerWebSocket } from "bun";
import type { PreviewRequest, PreviewResponse } from "@pi-cloud/protocol";
import type { Log } from "@pi-cloud/providers";
import type { Sessions } from "@pi-cloud/sessions";
import type { Auth } from "./auth";
import {
  fromSessionHost,
  type PreviewData,
  type SocketHandler,
  type SocketServer,
} from "./sockets";

interface Target {
  readonly sessionId: string;
  readonly port: number;
}

interface Visit extends Target {
  readonly userId: string;
  readonly expiresAt: number;
}

interface Exchange {
  readonly sessionId: string;
  readonly head: PreviewRequest;
  readonly requestBody: ArrayBuffer;
  readonly answer: (response: Response) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  host?: ServerWebSocket<PreviewData>;
  response?: ReadableStreamDefaultController<Uint8Array>;
}

const hostTimeoutMs = 10_000;
const grantMs = 60_000;
const visitMs = 12 * 60 * 60_000;
const cookieName = "pi-cloud-preview";

// Where a preview's origin trades a one-time grant for its cookie. Previewed
// apps don't use a path like this.
const admitPath = "/__pi-cloud/open";

const previewHost = /^(\d{1,5})--([0-9a-f-]{36})\.(.+)$/;
const openPath = /^\/api\/sessions\/([^/]+)\/previews\/(\d{1,5})$/;
const hostPath = /^\/agent\/sessions\/([^/]+)\/previews\/([\w-]{1,64})$/;

const hopByHop = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const nullBodyStatuses = new Set([101, 204, 205, 304]);

// Proxies a Session's port at its own origin, <port>--<session>.<host>, so
// the previewed app's scripts never run on Pi Cloud's origin (ADR 0022). Each
// request travels over a socket the Session host opens for it, as terminals
// do, and Pi Cloud's cookie never reaches the app (ADR 0037).
export function previewBroker(options: {
  readonly sessions: Sessions;
  readonly auth: Auth;
  // The names Pi Cloud goes by; a preview's host is one of them with a prefix.
  readonly siteHosts: ReadonlySet<string>;
  readonly secure: boolean;
  readonly log: Log;
}): {
  readonly visit: (
    request: Request,
    server: SocketServer,
  ) => Promise<Response | undefined>;
  readonly open: (request: Request) => Response | undefined;
  readonly upgrade: (
    request: Request,
    server: SocketServer,
  ) => Response | "upgraded" | undefined;
  readonly websocket: SocketHandler<PreviewData>;
} {
  const { sessions, auth, siteHosts, secure, log } = options;
  const grants = new Map<string, Visit>();
  const visits = new Map<string, Visit>();
  const exchanges = new Map<string, Exchange>();

  const targetOf = (request: Request): Target | undefined => {
    const host = request.headers.get("host") ?? "";
    if (!URL.canParse(`http://${host}`)) {
      return undefined;
    }

    const match = previewHost.exec(new URL(`http://${host}`).hostname);
    const port = Number(match?.[1]);
    if (!match || !siteHosts.has(match[3] ?? "") || port < 1 || port > 65535) {
      return undefined;
    }

    return { sessionId: match[2] ?? "", port };
  };

  const forget = (now: number): void => {
    for (const tokens of [grants, visits]) {
      for (const [token, { expiresAt }] of tokens) {
        if (expiresAt <= now) {
          tokens.delete(token);
        }
      }
    }
  };

  const admit = (url: URL, target: Target): Response => {
    const token = url.searchParams.get("token") ?? "";
    const grant = grants.get(token);
    grants.delete(token);

    if (
      grant === undefined ||
      grant.expiresAt <= Date.now() ||
      !same(grant, target)
    ) {
      return refused();
    }

    const cookie = randomBytes(32).toString("base64url");
    visits.set(cookie, { ...grant, expiresAt: Date.now() + visitMs });

    const path = url.searchParams.get("path") ?? "/";

    return new Response(null, {
      status: 302,
      headers: {
        location: path.startsWith("/") && !path.startsWith("//") ? path : "/",
        "set-cookie": `${cookieName}=${cookie}; HttpOnly; SameSite=Lax; Path=/${secure ? "; Secure" : ""}`,
      },
    });
  };

  const forward = async (
    request: Request,
    target: Target,
    userId: string,
  ): Promise<Response> => {
    const connectionId = randomUUID();

    const sent = sessions.send(target.sessionId, {
      actor: `user:${userId}`,
      type: "preview",
      connectionId,
      port: target.port,
    });

    if (!sent.ok) {
      return new Response("This Session isn't running.", { status: 502 });
    }

    const url = new URL(request.url);

    const head: PreviewRequest = {
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: requestHeaders(request.headers),
    };

    const body = await request.arrayBuffer();

    return new Promise((answer) => {
      exchanges.set(connectionId, {
        sessionId: target.sessionId,
        head,
        requestBody: body,
        answer,
        timeout: setTimeout(() => {
          exchanges.delete(connectionId);
          log("preview not answered", { ...target, connectionId });
          answer(new Response("The Session didn't answer.", { status: 504 }));
        }, hostTimeoutMs),
      });
    });
  };

  return {
    visit: async (request, server) => {
      const target = targetOf(request);
      if (target === undefined) {
        return undefined;
      }

      const url = new URL(request.url);
      if (url.pathname === admitPath) {
        return admit(url, target);
      }

      const cookies = new Bun.CookieMap(request.headers.get("cookie") ?? "");
      const visit = visits.get(cookies.get(cookieName) ?? "");
      if (
        visit === undefined ||
        visit.expiresAt <= Date.now() ||
        !same(visit, target)
      ) {
        return refused();
      }

      // A previewed app may hold a request open, as server-sent events do.
      server.timeout(request, 0);

      return forward(request, target, visit.userId);
    },
    open: (request) => {
      const match = openPath.exec(new URL(request.url).pathname);
      if (!match || request.method !== "GET") {
        return undefined;
      }

      const user = auth.userOf(request);
      if (user === undefined) {
        return Response.json({ error: "signed_out" }, { status: 401 });
      }

      const sessionId = match[1] ?? "";
      const port = Number(match[2]);
      if (sessions.get(sessionId) === undefined || port < 1 || port > 65535) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      const host = request.headers.get("host") ?? "";
      const { hostname } = new URL(`http://${host}`);
      if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) {
        return Response.json(
          {
            error:
              "previews need Pi Cloud opened under a name, such as localhost, not an IP address",
          },
          { status: 400 },
        );
      }

      const now = Date.now();
      forget(now);

      const token = randomBytes(32).toString("base64url");

      grants.set(token, {
        sessionId,
        port,
        userId: user.id,
        expiresAt: now + grantMs,
      });

      const location = new URL(
        `${secure ? "https" : "http"}://${String(port)}--${sessionId}.${host}${admitPath}`,
      );

      location.searchParams.set("token", token);

      location.searchParams.set(
        "path",
        new URL(request.url).searchParams.get("path") ?? "/",
      );

      log("preview opened", { sessionId, port, user: user.id });

      return new Response(null, {
        status: 302,
        headers: { location: location.href },
      });
    },
    upgrade: (request, server) => {
      const match = hostPath.exec(new URL(request.url).pathname);
      if (!match) {
        return undefined;
      }

      const [, sessionId = "", connectionId = ""] = match;
      const exchange = exchanges.get(connectionId);
      if (
        exchange === undefined ||
        exchange.host !== undefined ||
        exchange.sessionId !== sessionId ||
        !fromSessionHost(request, sessions, auth, sessionId)
      ) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      return server.upgrade(request, {
        data: { kind: "preview", connectionId },
      })
        ? "upgraded"
        : Response.json({ error: "expected a websocket" }, { status: 400 });
    },
    websocket: {
      open: (ws) => {
        const exchange = exchanges.get(ws.data.connectionId);
        if (!exchange) {
          ws.close(1000, "preview closed");

          return;
        }

        exchange.host = ws;
        ws.send(JSON.stringify(exchange.head));
        ws.send(exchange.requestBody);
      },
      message: (ws, message) => {
        const exchange = exchanges.get(ws.data.connectionId);
        if (exchange?.host !== ws) {
          return;
        }

        if (typeof message !== "string") {
          exchange.response?.enqueue(new Uint8Array(message));

          return;
        }

        clearTimeout(exchange.timeout);
        const head = JSON.parse(message) as PreviewResponse;
        const headers = new Headers();
        for (const [name, value] of head.headers) {
          if (!hopByHop.has(name.toLowerCase())) {
            headers.append(name, value);
          }
        }

        if (nullBodyStatuses.has(head.status)) {
          exchange.answer(new Response(null, { status: head.status, headers }));

          return;
        }

        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            exchange.response = controller;
          },
          cancel: () => {
            exchanges.delete(ws.data.connectionId);
            ws.close(1000, "browser went away");
          },
        });

        exchange.answer(new Response(body, { status: head.status, headers }));
      },
      close: (ws, code, reason) => {
        const exchange = exchanges.get(ws.data.connectionId);
        if (exchange?.host !== ws) {
          return;
        }

        exchanges.delete(ws.data.connectionId);
        clearTimeout(exchange.timeout);

        if (exchange.response === undefined) {
          exchange.answer(
            new Response(reason || "The preview failed.", { status: 502 }),
          );

          return;
        }

        if (code === 1000) {
          exchange.response.close();
        } else {
          exchange.response.error(new Error(reason));
        }
      },
    },
  };
}

function same(a: Target, b: Target): boolean {
  return a.sessionId === b.sessionId && a.port === b.port;
}

function refused(): Response {
  return new Response("Open this preview from its Session in Pi Cloud again.", {
    status: 401,
  });
}

// Pi Cloud's own cookie for the preview stays out of the app's requests.
function requestHeaders(headers: Headers): [string, string][] {
  return [...headers].flatMap(([name, value]): [string, string][] => {
    if (hopByHop.has(name)) {
      return [];
    }

    if (name !== "cookie") {
      return [[name, value]];
    }

    const kept = value
      .split(";")
      .map((cookie) => cookie.trim())
      .filter((cookie) => cookie !== "" && !cookie.startsWith(`${cookieName}=`))
      .join("; ");

    return kept === "" ? [] : [[name, kept]];
  });
}
