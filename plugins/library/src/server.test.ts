import { expect, test } from "bun:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  eventBus,
  type PluginRoute,
  type PluginStore,
  type ToolCaller,
} from "@pi-cloud/plugins";
import { library } from "./server";

const member: ToolCaller = {
  session: {
    id: "session-1",
    environmentId: "environment-1",
    ownerId: "owner",
    provider: "local",
    workspace: { kind: "folder", path: "/work" },
    model: null,
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
    online: true,
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

function registered(): PluginRoute {
  const routes: PluginRoute[] = [];

  const events = eventBus((_type, error) => {
    throw error;
  });

  const unused = (): never => {
    throw new Error("not used by the library plugin");
  };

  library.register({
    owner: "owner",
    tools: { register: unused },
    events,
    sessions: {
      start: unused,
      get: unused,
      send: unused,
      notify: unused,
      transcript: unused,
      transcriptLength: unused,
    },
    routes: {
      handle: (route) => {
        routes.push(route);
      },
    },
    models: { offer: unused },
    store: memoryStore(),
    signal: new AbortController().signal,
    log: () => undefined,
  });

  events.publish({
    type: "projects.MemberAdded",
    sessionId: member.session.id,
    projectId: "p1",
  });

  const [route] = routes;
  if (route === undefined) {
    throw new Error("library registered no route");
  }

  return route;
}

async function put(
  route: PluginRoute,
  path: string,
  body: string,
  caller?: ToolCaller,
): Promise<void> {
  const request = new Request(`http://library/${path}`, {
    method: "PUT",
    body,
  });

  expect((await route(request, path, caller)).status).toBe(200);
}

async function get(route: PluginRoute, path: string): Promise<Response> {
  return route(new Request(`http://library/${path}`), path, undefined);
}

test("lists each file of a Project by name with its latest size and writer", async () => {
  const route = registered();

  await put(route, "projects/p1/files/b.txt", "first draft");
  await put(route, "projects/p1/files/a.txt", "a");
  await put(route, "files/b.txt", "final", member);
  await put(route, "projects/p2/files/c.txt", "elsewhere");

  expect(await (await get(route, "projects/p1/files")).json()).toEqual([
    {
      name: "a.txt",
      size: 1,
      actor: "user:owner",
      updatedAt: expect.any(String) as unknown,
    },
    {
      name: "b.txt",
      size: 5,
      actor: "session:session-1",
      updatedAt: expect.any(String) as unknown,
    },
  ]);

  expect(await (await get(route, "projects/p1/files/b.txt")).text()).toBe(
    "final",
  );
});
