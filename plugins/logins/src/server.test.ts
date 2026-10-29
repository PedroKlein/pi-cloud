import { expect, test } from "bun:test";
import type { ModelOffer, PluginRoute, RouteCaller } from "@pipoca/plugins";
import {
  fakeContext,
  fakeSession,
  fakeUser,
  served,
} from "@pipoca/plugins/testing";
import { logins } from "./server";

function registered(): {
  readonly route: PluginRoute;
  readonly offer: ModelOffer;
} {
  const routes: PluginRoute[] = [];
  const offers: ModelOffer[] = [];

  logins.register(
    fakeContext({
      routes: {
        handle: (route) => {
          routes.push(route);
        },
      },
      models: {
        offer: (offer) => {
          offers.push(offer);
        },
      },
    }),
  );

  const [route] = routes;
  const [offer] = offers;
  if (route === undefined || offer === undefined) {
    throw new Error("logins registered no route or offer");
  }

  return { route: served(route), offer };
}

const runnerOf = (userId: string): RouteCaller => ({
  kind: "session",
  session: fakeSession({ startedBy: userId }),
  actor: "session:session-1",
});

async function call(
  route: PluginRoute,
  caller: RouteCaller,
  path: string,
  body?: unknown,
): Promise<Response> {
  return route(
    new Request(`http://logins/${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
    path,
    caller,
  );
}

async function save(
  route: PluginRoute,
  userId: string,
  provider: string,
): Promise<void> {
  const { lease } = (await (
    await call(route, runnerOf(userId), `credentials/${provider}/lock`, {})
  ).json()) as { lease: string };

  const saved = await call(
    route,
    runnerOf(userId),
    `credentials/${provider}/release`,
    { lease, value: { type: "api_key", key: "sk" } },
  );

  expect(saved.status).toBe(200);
}

test("a person sees their own logins and can log out of one", async () => {
  const { route } = registered();
  await save(route, "ana", "anthropic");
  await save(route, "bo", "openai");

  const account = await call(route, fakeUser({ id: "ana" }), "account");

  expect(await account.json()).toMatchObject({
    logins: [{ provider: "anthropic", type: "api_key" }],
  });

  const removed = await call(route, fakeUser({ id: "ana" }), "remove", {
    provider: "anthropic",
  });

  expect(await removed.json()).toEqual({ logins: [], mcp: [] });

  const other = await call(route, fakeUser({ id: "bo" }), "account");

  expect(await other.json()).toMatchObject({
    logins: [{ provider: "openai" }],
  });
});

test("a person saves a login, such as an API key, that their Sessions read", async () => {
  const { route } = registered();

  const saved = await call(route, fakeUser({ id: "ana" }), "save", {
    provider: "openai",
    credential: { type: "api_key", key: "sk" },
  });

  expect(await saved.json()).toMatchObject({
    logins: [{ provider: "openai", type: "api_key" }],
  });

  const read = await route(
    new Request("http://logins/credentials?values"),
    "credentials",
    runnerOf("ana"),
  );

  expect(await read.json()).toEqual({
    openai: { type: "api_key", key: "sk" },
  });
});

test("a write without the lease is refused", async () => {
  const { route } = registered();

  const refused = await call(
    route,
    runnerOf("ana"),
    "credentials/anthropic/release",
    { lease: "made-up", value: { type: "api_key", key: "sk" } },
  );

  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "lease_lapsed" });
});

test("a login that isn't one is refused", async () => {
  const { route } = registered();

  const { lease } = (await (
    await call(route, runnerOf("ana"), "credentials/anthropic/lock", {})
  ).json()) as { lease: string };

  const refused = await call(
    route,
    runnerOf("ana"),
    "credentials/anthropic/release",
    { lease, value: { key: "sk" } },
  );

  expect(refused.status).toBe(400);
});

test("a person is offered Pi's models of the providers they logged in to", async () => {
  const { route, offer } = registered();
  await save(route, "ana", "anthropic");

  // Pi's catalog loads in the background.
  for (let tries = 0; tries < 100; tries++) {
    if (offer("environment-1", "ana").models.length > 0) {
      break;
    }

    await Bun.sleep(20);
  }

  const offered = offer("environment-1", "ana").models;
  expect(offered.length).toBeGreaterThan(0);
  expect(offered.every(({ provider }) => provider === "anthropic")).toBe(true);
  expect(offer("environment-1", "bo").models).toEqual([]);
  expect(offer("environment-1").models).toEqual([]);
});
