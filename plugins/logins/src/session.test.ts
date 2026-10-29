import { expect, test } from "bun:test";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type { PluginRoute, SessionCloud } from "@pipoca/plugins";
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
function runner(route: PluginRoute, userId: string): CredentialStore {
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
  } as SessionCloud;

  const credentials = logins.credentials?.(cloud);
  if (credentials === undefined) {
    throw new Error("logins keeps no credentials");
  }

  return credentials;
}

const oauth = (access: string): Credential => ({
  type: "oauth",
  access,
  refresh: `refresh-${access}`,
  expires: 0,
});

test("a login made on one runner is there on another, for its owner only", async () => {
  const route = serverRoute();

  await runner(route, "ana").modify("openai-codex", async () =>
    Promise.resolve(oauth("a1")),
  );

  expect(await runner(route, "ana").read("openai-codex")).toEqual(oauth("a1"));

  expect(await runner(route, "ana").list()).toEqual([
    { providerId: "openai-codex", type: "oauth" },
  ]);

  expect(await runner(route, "bo").read("openai-codex")).toBeUndefined();
  expect(await runner(route, "bo").list()).toEqual([]);
});

test("runners refresh one login one at a time, each seeing the last write", async () => {
  const route = serverRoute();

  await runner(route, "ana").modify("openai-codex", async () =>
    Promise.resolve(oauth("t0")),
  );

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
    refresh(runner(route, "ana")),
    refresh(runner(route, "ana")),
  ]);

  expect(seen).toEqual(["t0", "t0+"]);

  expect(await runner(route, "ana").read("openai-codex")).toEqual(
    oauth("t0++"),
  );
});

test("a failed refresh lets go of the login and keeps it", async () => {
  const route = serverRoute();
  const store = runner(route, "ana");
  await store.modify("anthropic", async () => Promise.resolve(oauth("k")));

  expect(
    store.modify("anthropic", async () => Promise.reject(new Error("refused"))),
  ).rejects.toThrow("refused");

  await store.modify("anthropic", async (current) => Promise.resolve(current));

  expect(await store.read("anthropic")).toEqual(oauth("k"));
});

test("logging out removes the login on every runner", async () => {
  const route = serverRoute();

  await runner(route, "ana").modify("anthropic", async () =>
    Promise.resolve({ type: "api_key", key: "sk" }),
  );

  await runner(route, "ana").delete("anthropic");

  expect(await runner(route, "ana").read("anthropic")).toBeUndefined();
});
