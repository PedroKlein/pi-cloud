import { afterEach, expect, test } from "bun:test";
import { api, send } from "./api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function respond(response: () => Response): void {
  globalThis.fetch = Object.assign(
    async () => Promise.resolve(response()),
    realFetch,
  );
}

test("api and send reject with the status when an error response isn't JSON", async () => {
  respond(
    () =>
      new Response("upstream connect error", {
        status: 503,
        statusText: "Service Unavailable",
      }),
  );

  expect(await api("/api/sessions").catch(String)).toBe(
    "Error: 503 Service Unavailable",
  );

  expect(await send("/api/pinned-pages", "PUT", {}).catch(String)).toBe(
    "Error: 503 Service Unavailable",
  );
});

test("api rejects with the server's error message", async () => {
  respond(() => Response.json({ error: "signed_out" }, { status: 401 }));

  expect(await api("/api/sessions").catch(String)).toBe("Error: signed_out");
});
