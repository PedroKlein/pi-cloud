import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  eventBus,
  type PluginRoute,
  type PluginStore,
  type ToolCaller,
} from "@pi-cloud/plugins";
import { models } from "./server";

const environmentId = "environment-1";

const caller: ToolCaller = {
  session: {
    id: "session-1",
    environmentId,
    ownerId: "owner",
    owner: null,
    provider: "local",
    runner: null,
    profileId: "profile-1",
    workspace: { kind: "folder", path: "/work" },
    model: null,
    thinking: null,
    systemPrompt: null,
    firstMessage: null,
    title: null,
    status: "idle",
    generation: 1,
    createdAt: "2026-10-22T00:00:00.000Z",
    interruptedAt: null,
    error: null,
    archivedAt: null,
    workspaceRemoval: null,
    workspaceKeptReason: null,
    online: true,
    waiting: false,
  },
  actor: "session:session-1",
};

function memoryStore(): PluginStore {
  const db = new DatabaseSync(":memory:");

  return {
    exec: (sql) => {
      db.exec(sql);
    },
    all: (sql, ...params) =>
      db.prepare(sql).all(...(params as SQLInputValue[])),
    run: (sql, ...params) => {
      db.prepare(sql).run(...(params as SQLInputValue[]));
    },
  };
}

function registered(signal: AbortSignal): PluginRoute {
  const routes: PluginRoute[] = [];

  const unused = (): never => {
    throw new Error("not used by the models plugin");
  };

  models.register({
    owner: "owner",
    tools: { register: unused },
    events: eventBus(unused),
    environments: {
      list: unused,
      unplaced: unused,
      runnerToken: unused,
      revokeRunner: unused,
    },
    sessions: {
      start: unused,
      get: unused,
      owned: unused,
      adopt: unused,
      archive: unused,
      unarchive: unused,
      send: unused,
      notify: unused,
      transcript: unused,
      transcriptLength: unused,
    },
    profiles: { provide: unused },
    routes: {
      handle: (route) => {
        routes.push(route);
      },
    },
    models: { offer: () => undefined },
    store: memoryStore(),
    settings: { get: () => ({}) },
    signal,
    log: () => undefined,
  });

  const [route] = routes;
  if (route === undefined) {
    throw new Error("models registered no route");
  }

  return route;
}

async function configVersion(
  route: PluginRoute,
  after?: number,
  signal: AbortSignal | null = null,
): Promise<number> {
  const query = after === undefined ? "" : `?after=${String(after)}`;
  const request = new Request(`http://models/config${query}`, { signal });
  const response = await route(request, "config", caller);
  const { version } = (await response.json()) as { version: number };

  return version;
}

async function clearAliases(route: PluginRoute): Promise<void> {
  const request = new Request(`http://models/environments/${environmentId}`, {
    method: "POST",
    body: JSON.stringify({ aliases: null }),
  });

  await route(request, `environments/${environmentId}`, undefined);
}

async function saveAliases(
  route: PluginRoute,
  body: string,
): Promise<Response> {
  const request = new Request(`http://models/environments/${environmentId}`, {
    method: "POST",
    body,
  });

  return route(request, `environments/${environmentId}`, undefined);
}

async function savedAliases(route: PluginRoute): Promise<unknown> {
  const request = new Request("http://models/environments");
  const response = await route(request, "environments", undefined);
  const [saved] = (await response.json()) as { aliases: unknown }[];

  return saved?.aliases;
}

const aliases = { models: { fast: ["local/llama"] } };

test.each([
  ["no body", ""],
  ["broken JSON", '{"aliases":'],
  ["no aliases key", "{}"],
  ["a misspelled aliases key", JSON.stringify({ alias: aliases })],
])("a save with %s keeps the saved aliases", async (_, body) => {
  const route = registered(new AbortController().signal);
  await saveAliases(route, JSON.stringify({ aliases }));
  const seen = await configVersion(route);

  const response = await saveAliases(route, body);

  expect(response.status).toBe(400);
  expect(await savedAliases(route)).toEqual(aliases);
  expect(await configVersion(route)).toBe(seen);
});

test("a save with null aliases turns them off", async () => {
  const route = registered(new AbortController().signal);
  await saveAliases(route, JSON.stringify({ aliases }));

  await clearAliases(route);

  expect(await savedAliases(route)).toBeNull();
});

test("a config wait woken by a change leaves no listener on the server signal", async () => {
  const server = new AbortController();
  const route = registered(server.signal);
  const seen = await configVersion(route);

  const waited = configVersion(route, seen);
  await clearAliases(route);

  expect(await waited).toBe(seen + 1);
  expect(getEventListeners(server.signal, "abort")).toHaveLength(0);
});

test("a config wait the client gave up on leaves no listener on the server signal", async () => {
  const server = new AbortController();
  const route = registered(server.signal);
  const seen = await configVersion(route);

  const client = new AbortController();
  const waited = configVersion(route, seen, client.signal);
  client.abort();

  expect(await waited).toBe(seen);
  expect(getEventListeners(server.signal, "abort")).toHaveLength(0);
});

test("a config wait for a client that already left returns at once", async () => {
  const server = new AbortController();
  const route = registered(server.signal);
  const seen = await configVersion(route);

  expect(await configVersion(route, seen, AbortSignal.abort())).toBe(seen);
  expect(getEventListeners(server.signal, "abort")).toHaveLength(0);
});

test("a config wait returns when the server stops", async () => {
  const server = new AbortController();
  const route = registered(server.signal);
  const seen = await configVersion(route);

  const waited = configVersion(route, seen);
  server.abort();

  expect(await waited).toBe(seen);
});

test("a config wait after the server stopped answers 503 so the Session backs off", async () => {
  const server = new AbortController();
  const route = registered(server.signal);
  const seen = await configVersion(route);
  server.abort();

  const request = new Request(`http://models/config?after=${String(seen)}`);
  const response = await route(request, "config", caller);

  expect(response.status).toBe(503);
  expect(getEventListeners(server.signal, "abort")).toHaveLength(0);
});
