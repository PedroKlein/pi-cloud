import { afterEach, beforeEach, expect, test } from "bun:test";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";

let server: ReturnType<typeof serve>;
let signedIn: () => Promise<string>;

beforeEach(() => {
  const logs: string[] = [];

  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 0 },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
});

afterEach(async () => {
  await server.stop();
});

async function pinned(body?: unknown): Promise<Response> {
  return fetch(new URL("/api/pinned-pages", server.url), {
    method: body === undefined ? "GET" : "PUT",
    headers: {
      cookie: await signedIn(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

test("keeps the plugin pages a user pins, with none chosen until they pin one", async () => {
  expect(await (await pinned()).json()).toEqual({ pages: null });

  expect((await pinned({ pages: ["projects", "library"] })).status).toBe(204);

  expect(await (await pinned()).json()).toEqual({
    pages: ["projects", "library"],
  });

  expect((await pinned({ pages: [] })).status).toBe(204);
  expect(await (await pinned()).json()).toEqual({ pages: [] });
});

test("refuses pinned pages that aren't a list of names", async () => {
  const refused = await pinned({ pages: "projects" });

  expect(refused.status).toBe(400);
  expect(await (await pinned()).json()).toEqual({ pages: null });
});

test("needs a signed-in user", async () => {
  const response = await fetch(new URL("/api/pinned-pages", server.url));

  expect(response.status).toBe(401);
});
