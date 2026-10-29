import { expect, test } from "bun:test";
import type { ModelOffer, PluginRoute, RouteCaller } from "@pipoca/plugins";
import {
  fakeContext,
  fakeSession,
  fakeUser,
  served,
} from "@pipoca/plugins/testing";
import type { Account, Connectable } from "./model";
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

  const removed = await route(
    new Request("http://logins/credentials/anthropic", { method: "DELETE" }),
    "credentials/anthropic",
    fakeUser({ id: "ana" }),
  );

  expect(await removed.json()).toEqual({ logins: [], mcp: [] });

  const other = await call(route, fakeUser({ id: "bo" }), "account");

  expect(await other.json()).toMatchObject({
    logins: [{ provider: "openai" }],
  });
});

test("a person logs out of an MCP server by its name and address", async () => {
  const { route } = registered();
  const server = encodeURIComponent("linear https://mcp.linear.app/mcp");

  const { lease } = (await (
    await call(route, runnerOf("ana"), `mcp/${server}/lock`, {})
  ).json()) as { lease: string };

  const saved = await call(route, runnerOf("ana"), `mcp/${server}/release`, {
    lease,
    value: { tokens: {} },
  });

  expect(saved.status).toBe(200);

  const removed = await route(
    new Request(`http://logins/mcp/${server}`, { method: "DELETE" }),
    `mcp/${server}`,
    fakeUser({ id: "ana" }),
  );

  expect(await removed.json()).toEqual({ logins: [], mcp: [] });
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

async function connectable(route: PluginRoute): Promise<void> {
  // Pi's providers load in the background.
  for (let tries = 0; tries < 100; tries++) {
    const providers = (await (
      await call(route, fakeUser({ id: "ana" }), "providers")
    ).json()) as unknown[];

    if (providers.length > 0) {
      return;
    }

    await Bun.sleep(20);
  }
}

async function connection(
  route: PluginRoute,
  userId: string,
  until: (account: Account) => boolean,
): Promise<Account> {
  for (let tries = 0; ; tries++) {
    const account = (await (
      await call(route, fakeUser({ id: userId }), "account")
    ).json()) as Account;

    if (until(account) || tries === 100) {
      return account;
    }

    await Bun.sleep(20);
  }
}

test("a person connects a provider from Settings by answering Pi's prompts", async () => {
  const { route } = registered();
  await connectable(route);

  const providers = (await (
    await call(route, fakeUser({ id: "ana" }), "providers")
  ).json()) as Connectable[];

  expect(providers.find(({ id }) => id === "openai")?.methods).toContainEqual({
    type: "api_key",
    label: "API key",
  });

  await call(route, fakeUser({ id: "ana" }), "connect", {
    provider: "openai",
    type: "api_key",
  });

  const asked = await connection(
    route,
    "ana",
    ({ connection: current }) => current?.prompt !== undefined,
  );

  const prompt = asked.connection?.prompt;
  expect(prompt).toMatchObject({ type: "secret" });

  const answered = await call(
    route,
    fakeUser({ id: "ana" }),
    "connection/answer",
    { prompt: prompt?.id, answer: "sk-ana" },
  );

  expect(answered.status).toBe(200);

  const done = await connection(
    route,
    "ana",
    ({ connection: current }) => current?.state !== "running",
  );

  expect(done.connection?.state).toBe("done");
  expect(done.logins).toMatchObject([{ provider: "openai", type: "api_key" }]);

  const read = await route(
    new Request("http://logins/credentials?values"),
    "credentials",
    runnerOf("ana"),
  );

  expect(await read.json()).toEqual({
    openai: { type: "api_key", key: "sk-ana" },
  });

  const other = await call(route, fakeUser({ id: "bo" }), "account");
  expect(await other.json()).toEqual({ logins: [], mcp: [] });
});

test("a person dismisses a sign-in and it stops asking", async () => {
  const { route } = registered();
  await connectable(route);

  await call(route, fakeUser({ id: "ana" }), "connect", {
    provider: "openai",
    type: "api_key",
  });

  const asked = await connection(
    route,
    "ana",
    ({ connection: current }) => current?.prompt !== undefined,
  );

  const dismissed = await route(
    new Request("http://logins/connection", { method: "DELETE" }),
    "connection",
    fakeUser({ id: "ana" }),
  );

  expect(await dismissed.json()).toEqual({ logins: [], mcp: [] });

  const late = await call(route, fakeUser({ id: "ana" }), "connection/answer", {
    prompt: asked.connection?.prompt?.id,
    answer: "sk-ana",
  });

  expect(late.status).toBe(409);
});

test("a sign-in a provider doesn't take is refused", async () => {
  const { route } = registered();
  await connectable(route);

  const refused = await call(route, fakeUser({ id: "ana" }), "connect", {
    provider: "openai-codex",
    type: "api_key",
  });

  expect(refused.status).toBe(400);
});
