import { expect, test } from "bun:test";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type {
  McpLoginState,
  PluginRoute,
  SessionCloud,
  SessionLogins,
} from "@pipoca/plugins";
import { fakeContext, fakeSession, served } from "@pipoca/plugins/testing";
import { logins as server } from "./server";
import { logins } from "./session";

function serverRoute(): PluginRoute {
  const routes: PluginRoute[] = [];

  server.register(
    fakeContext({
      routes: {
        handle: (route) => {
          routes.push(route);
        },
      },
      models: { offer: () => undefined },
    }),
  );

  const [route] = routes;
  if (route === undefined) {
    throw new Error("logins registered no route");
  }

  return served(route);
}

// A runner's Session of the owner, sending its requests to the server's
// route as Pipoca does.
async function runner(
  route: PluginRoute,
  userId: string,
): Promise<SessionLogins> {
  const session = fakeSession({ startedBy: userId });

  const cloud = {
    request: async (path: string, init?: RequestInit) => {
      const url = new URL(`http://logins/${path}`);

      return route(new Request(url.href, init), url.pathname.slice(1), {
        kind: "session",
        session,
        actor: `session:${session.id}`,
      });
    },
    log: () => undefined,
  } as unknown as SessionCloud;

  const kept = await logins.logins?.(cloud);
  if (kept === undefined) {
    throw new Error("logins keeps no logins");
  }

  return kept;
}

const oauth = (access: string): Credential => ({
  type: "oauth",
  access,
  refresh: `refresh-${access}`,
  expires: 0,
});

test("a login made on one runner is there on another, for its owner only", async () => {
  const route = serverRoute();

  await (
    await runner(route, "ana")
  ).models.modify("openai-codex", async () => Promise.resolve(oauth("a1")));

  expect(
    await (await runner(route, "ana")).models.read("openai-codex"),
  ).toEqual(oauth("a1"));

  expect(await (await runner(route, "ana")).models.list()).toEqual([
    { providerId: "openai-codex", type: "oauth" },
  ]);

  expect(
    await (await runner(route, "bo")).models.read("openai-codex"),
  ).toBeUndefined();

  expect(await (await runner(route, "bo")).models.list()).toEqual([]);
});

test("runners refresh one login one at a time, each seeing the last write", async () => {
  const route = serverRoute();

  await (
    await runner(route, "ana")
  ).models.modify("openai-codex", async () => Promise.resolve(oauth("t0")));

  const seen: string[] = [];

  const refresh = async (store: CredentialStore): Promise<void> => {
    await store.modify("openai-codex", async (current) => {
      const access = current?.type === "oauth" ? current.access : "none";
      seen.push(access);
      await Bun.sleep(20);

      return oauth(`${access}+`);
    });
  };

  await Promise.all([
    refresh((await runner(route, "ana")).models),
    refresh((await runner(route, "ana")).models),
  ]);

  expect(seen).toEqual(["t0", "t0+"]);

  expect(
    await (await runner(route, "ana")).models.read("openai-codex"),
  ).toEqual(oauth("t0++"));
});

test("a failed refresh lets go of the login and keeps it", async () => {
  const route = serverRoute();
  const store = (await runner(route, "ana")).models;
  await store.modify("anthropic", async () => Promise.resolve(oauth("k")));

  expect(
    store.modify("anthropic", async () => Promise.reject(new Error("refused"))),
  ).rejects.toThrow("refused");

  await store.modify("anthropic", async (current) => Promise.resolve(current));

  expect(await store.read("anthropic")).toEqual(oauth("k"));
});

test("logging out removes the login on every runner", async () => {
  const route = serverRoute();

  await (
    await runner(route, "ana")
  ).models.modify("anthropic", async () =>
    Promise.resolve({ type: "api_key", key: "sk" }),
  );

  await (await runner(route, "ana")).models.delete("anthropic");

  expect(
    await (await runner(route, "ana")).models.read("anthropic"),
  ).toBeUndefined();
});

const mcpState = (access: string): McpLoginState => ({
  client: { client_id: "pi" },
  tokens: { access_token: access, refresh_token: `refresh-${access}` },
});

const linear = ["linear", "https://mcp.linear.app/mcp"] as const;

// Writes go back to the server in the background, so another runner sees
// them a moment later.
async function eventually<T>(read: () => Promise<T>, wanted: T): Promise<T> {
  for (let tries = 0; tries < 50; tries++) {
    const value = await read();
    if (Bun.deepEquals(value, wanted)) {
      return value;
    }

    await Bun.sleep(10);
  }

  return read();
}

test("an MCP sign-in on one runner is there on another, for its owner only", async () => {
  const route = serverRoute();
  (await runner(route, "ana")).mcp.forServer(...linear).save(mcpState("m1"));

  const loaded = async (userId: string) =>
    (await runner(route, userId)).mcp.forServer(...linear).load();

  expect(await eventually(async () => loaded("ana"), mcpState("m1"))).toEqual(
    mcpState("m1"),
  );

  expect(await loaded("bo")).toBeUndefined();
});

test("runners refresh one MCP login one at a time, each seeing the last write", async () => {
  const route = serverRoute();
  (await runner(route, "ana")).mcp.forServer(...linear).save(mcpState("t0"));
  const first = await runner(route, "ana");
  const second = await runner(route, "ana");

  await eventually(
    async () => (await runner(route, "ana")).mcp.forServer(...linear).load(),
    mcpState("t0"),
  );

  const seen: string[] = [];

  const refresh = async ({ mcp }: SessionLogins): Promise<void> => {
    const login = mcp.forServer(...linear);

    await login.withRefreshLock(async () => {
      const access = (login.load()?.tokens as { access_token: string })
        .access_token;

      seen.push(access);
      await Bun.sleep(20);
      login.save(mcpState(`${access}+`));
    });
  };

  await Promise.all([refresh(first), refresh(second)]);

  expect(seen).toEqual(["t0", "t0+"]);

  expect((await runner(route, "ana")).mcp.forServer(...linear).load()).toEqual(
    mcpState("t0++"),
  );
});

test("an MCP logout reaches every runner", async () => {
  const route = serverRoute();
  const { mcp } = await runner(route, "ana");
  mcp.forServer(...linear).save(mcpState("m1"));

  expect(mcp.remove(...linear)).toBe(true);

  expect(
    await eventually(
      async () => (await runner(route, "ana")).mcp.tokens(...linear),
      undefined,
    ),
  ).toBeUndefined();
});
