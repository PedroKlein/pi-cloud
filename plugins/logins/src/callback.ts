import { createHash, randomBytes } from "node:crypto";
import { type AuthorizationResponse, responseOf } from "./mcp";

const browserCookie = "pipoca-logins";
const cookiePath = "/api/plugins/logins/";
const callbackPath = `${cookiePath}callback`;

export interface Callbacks {
  // Marks the browser that starts a sign-in, so only it can finish it.
  readonly browser: (request: Request) => {
    readonly id: string;
    readonly cookie: string;
  };
  // Waits for the sign-in page to send the browser back with state.
  readonly wait: (
    browser: string,
  ) => (state: string, signal: AbortSignal) => Promise<AuthorizationResponse>;
  // Where the sign-in page sends the browser, signed in to Pipoca or not:
  // the session cookie stays off a navigation from another site.
  readonly handle: (request: Request) => Response;
}

interface Waiting {
  readonly browser: string;
  readonly resolve: (response: AuthorizationResponse) => void;
  readonly reject: (error: Error) => void;
}

export function callbacks(): Callbacks {
  const waiting = new Map<string, Waiting>();

  return {
    browser: (request) => {
      const id = randomBytes(32).toString("base64url");

      return {
        id,
        cookie: new Bun.Cookie(browserCookie, id, {
          path: cookiePath,
          httpOnly: true,
          sameSite: "lax",
          secure: secure(request),
        }).serialize(),
      };
    },
    wait: (browser) => async (state, signal) =>
      new Promise((resolve, reject) => {
        const forget = (): void => {
          waiting.delete(state);
          reject(new Error("Login cancelled"));
        };

        signal.addEventListener("abort", forget, { once: true });

        waiting.set(state, {
          browser: hash(browser),
          resolve: (response) => {
            signal.removeEventListener("abort", forget);
            resolve(response);
          },
          reject: (error) => {
            signal.removeEventListener("abort", forget);
            reject(error);
          },
        });
      }),
    handle: (request) => {
      const state = new URL(request.url).searchParams.get("state") ?? "";
      const waiter = waiting.get(state);

      const browser = new Bun.CookieMap(
        request.headers.get("cookie") ?? "",
      ).get(browserCookie);

      // The state must come back to the browser that left with it, so a
      // link can't sign someone else in (RFC 6749, 10.12).
      if (
        waiter === undefined ||
        browser === null ||
        hash(browser) !== waiter.browser
      ) {
        return page(
          "This sign-in has expired. Start it again from Settings.",
          400,
        );
      }

      waiting.delete(state);

      try {
        waiter.resolve(responseOf(request.url, state));
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));

        waiter.reject(failure);

        return page(failure.message, 403);
      }

      return page("Signed in. You can close this tab.", 200);
    },
  };
}

// Pipoca's own address for the sign-in page to send the browser back to.
// The Host header already passed the server's own site check.
export function callbackUrl(request: Request): string {
  const host = request.headers.get("host") ?? new URL(request.url).host;

  return `${secure(request) ? "https" : "http"}://${host}${callbackPath}`;
}

// HTTPS usually ends in a gateway in front of the server (ADR 0034).
function secure(request: Request): boolean {
  return (
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https"
  );
}

function page(message: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Pipoca</title><p>${escaped(message)}</p><p><a href="/#settings/logins">Back to Pipoca</a></p>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
