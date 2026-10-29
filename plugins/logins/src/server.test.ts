import { expect, test } from "bun:test";
import type {
  ModelOffer,
  PluginRoute,
  ProfileMcpServer,
  PublicRoute,
  RouteCaller,
} from "@pipoca/plugins";
import {
  fakeContext,
  fakeSession,
  fakeUser,
  served,
} from "@pipoca/plugins/testing";
import type { Account, Connectable } from "./model";
import { logins } from "./server";

function registered(mcpServers: readonly ProfileMcpServer[] = []): {
  readonly route: PluginRoute;
  readonly offer: ModelOffer;
  readonly callback: (request: Request) => Promise<Response | undefined>;
} {
  const routes: PluginRoute[] = [];
  const offers: ModelOffer[] = [];
  const publicRoutes: PublicRoute[] = [];
  const faked = fakeContext();

  logins.register(
    fakeContext({
      auth: {
        ...faked.auth,
        handlePublic: (route) => {
          publicRoutes.push(route);
        },
      },
      profiles: { ...faked.profiles, mcpServers: () => mcpServers },
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
  const [publicRoute] = publicRoutes;
  if (route === undefined || offer === undefined || publicRoute === undefined) {
    throw new Error("logins registered no route, offer or callback");
  }

  return {
    route: served(route),
    offer,
    callback: async (request) =>
      publicRoute(
        request,
        new URL(request.url).pathname.split("/").at(-1) ?? "",
      ),
  };
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

  expect(await removed.json()).toEqual({ logins: [], mcp: [], servers: [] });

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
  expect(await other.json()).toEqual({ logins: [], mcp: [], servers: [] });
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

  expect(await dismissed.json()).toEqual({ logins: [], mcp: [], servers: [] });

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

// An MCP server with its own authorization server, which registers any
// client and swaps the code "granted" for tokens.
function oauthServer(): { readonly url: string; readonly stop: () => void } {
  const server: Bun.Server<undefined> = Bun.serve({
    port: 0,
    fetch: async (request): Promise<Response> => {
      const { pathname } = new URL(request.url);
      const origin = server.url.origin;

      if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        });
      }

      if (
        pathname.startsWith("/.well-known/oauth-authorization-server") ||
        pathname.startsWith("/.well-known/openid-configuration")
      ) {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }

      if (pathname === "/register") {
        const metadata = (await request.json()) as Record<string, unknown>;

        return Response.json(
          { ...metadata, client_id: "client-1" },
          { status: 201 },
        );
      }

      if (pathname === "/token") {
        const params = new URLSearchParams(await request.text());

        return params.get("code") === "granted"
          ? Response.json({
              access_token: "access-1",
              refresh_token: "refresh-1",
              token_type: "Bearer",
              expires_in: 3600,
            })
          : Response.json({ error: "invalid_grant" }, { status: 400 });
      }

      return new Response("unauthorized", {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    },
  });

  return {
    url: `${server.url.origin}/mcp`,
    stop: () => {
      void server.stop(true);
    },
  };
}

test("a person signs in to an MCP server of their Profiles from Settings, and the sign-in page sends them back to Pipoca", async () => {
  const linear = oauthServer();
  try {
    const { route, callback } = registered([
      { name: "linear", config: { url: linear.url } },
      { name: "local", config: { command: "linear-mcp" } },
    ]);

    const key = `linear ${linear.url}`;

    const listed = (await (
      await call(route, fakeUser({ id: "ana" }), "account")
    ).json()) as Account;

    expect(listed.servers).toEqual([{ key, name: "linear", url: linear.url }]);

    const started = await call(route, fakeUser({ id: "ana" }), "connect-mcp", {
      server: key,
    });

    const cookie =
      (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const asked = await connection(route, "ana", ({ connection: current }) =>
      (current?.events ?? []).some(({ type }) => type === "auth_url"),
    );

    const event = asked.connection?.events.find(
      ({ type }) => type === "auth_url",
    );

    const page = new URL(event?.type === "auth_url" ? event.url : "");
    const back = new URL(page.searchParams.get("redirect_uri") ?? "");
    expect(back.href).toBe("http://logins/api/plugins/logins/callback");

    back.search = new URLSearchParams({
      code: "granted",
      state: page.searchParams.get("state") ?? "",
    }).toString();

    const elsewhere = await callback(new Request(back.href));
    expect(elsewhere?.status).toBe(400);

    const returned = await callback(
      new Request(back.href, { headers: { cookie } }),
    );

    expect(returned?.status).toBe(200);

    const done = await connection(
      route,
      "ana",
      ({ connection: current }) => current?.state !== "running",
    );

    expect(done.connection).toMatchObject({ state: "done" });
    expect(done.mcp).toMatchObject([{ server: key }]);

    const read = await route(
      new Request("http://logins/mcp?values"),
      "mcp",
      runnerOf("ana"),
    );

    expect(await read.json()).toMatchObject({
      [key]: {
        tokens: { access_token: "access-1", refresh_token: "refresh-1" },
      },
    });
  } finally {
    linear.stop();
  }
});

test("a client registered for a loopback address signs in with the address the person pastes", async () => {
  const linear = oauthServer();
  try {
    const { route } = registered([
      {
        name: "linear",
        config: {
          url: linear.url,
          oauth: { clientId: "registered", callbackPort: 8123 },
        },
      },
      {
        name: "secret",
        config: { url: linear.url, oauth: { clientSecret: "${SECRET}" } },
      },
    ]);

    const key = `linear ${linear.url}`;

    await call(route, fakeUser({ id: "ana" }), "connect-mcp", { server: key });

    const asked = await connection(
      route,
      "ana",
      ({ connection: current }) => current?.prompt !== undefined,
    );

    expect(asked.servers.map(({ name }) => name)).toEqual(["linear"]);
    expect(asked.connection?.prompt).toMatchObject({ type: "manual_code" });

    const event = asked.connection?.events.find(
      ({ type }) => type === "auth_url",
    );

    const page = new URL(event?.type === "auth_url" ? event.url : "");
    expect(page.searchParams.get("client_id")).toBe("registered");

    expect(page.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8123/callback",
    );

    await call(route, fakeUser({ id: "ana" }), "connection/answer", {
      prompt: asked.connection?.prompt?.id,
      answer: `http://127.0.0.1:8123/callback?code=granted&state=${page.searchParams.get("state") ?? ""}`,
    });

    const done = await connection(
      route,
      "ana",
      ({ connection: current }) => current?.state !== "running",
    );

    expect(done.connection).toMatchObject({ state: "done" });
    expect(done.mcp).toMatchObject([{ server: key }]);
  } finally {
    linear.stop();
  }
});
