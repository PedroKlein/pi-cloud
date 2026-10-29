import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Session } from "@pipoca/protocol";
import { eventBus } from "./events";
import { HttpError } from "./http";
import type {
  PluginRoute,
  PluginStore,
  RouteCaller,
  ServerPluginContext,
} from "./plugin";

// A store in memory that seals nothing, for a plugin's tests.
export function memoryStore(): PluginStore {
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
    seal: (text) => text,
    open: (sealed) => sealed,
  };
}

// A context for calling a server plugin's register in a test. Members the
// test doesn't pass throw when called, except the ones every plugin gets,
// which do nothing or keep to memory.
export function fakeContext(
  members: Partial<ServerPluginContext> = {},
): ServerPluginContext {
  const notFaked = (name: string) => (): never => {
    throw new Error(`${name} is not faked; pass it to fakeContext`);
  };

  return {
    owner: "owner",
    tools: { register: notFaked("tools.register") },
    toolsets: {
      register: notFaked("toolsets.register"),
      loadInOwnSessions: notFaked("toolsets.loadInOwnSessions"),
    },
    events: eventBus((_type, error) => {
      throw error;
    }),
    changes: { publish: () => undefined },
    sessions: {
      start: notFaked("sessions.start"),
      get: notFaked("sessions.get"),
      owned: notFaked("sessions.owned"),
      loadOnly: notFaked("sessions.loadOnly"),
      adopt: notFaked("sessions.adopt"),
      archive: notFaked("sessions.archive"),
      unarchive: notFaked("sessions.unarchive"),
      send: notFaked("sessions.send"),
      notify: notFaked("sessions.notify"),
      transcript: notFaked("sessions.transcript"),
      transcriptLength: notFaked("sessions.transcriptLength"),
    },
    environments: {
      list: notFaked("environments.list"),
      unplaced: notFaked("environments.unplaced"),
      runnerToken: notFaked("environments.runnerToken"),
      revokeRunner: notFaked("environments.revokeRunner"),
      startsRunners: notFaked("environments.startsRunners"),
    },
    profiles: { provide: notFaked("profiles.provide") },
    routes: { handle: notFaked("routes.handle") },
    auth: {
      offer: notFaked("auth.offer"),
      handlePublic: notFaked("auth.handlePublic"),
      userOf: notFaked("auth.userOf"),
      createUser: notFaked("auth.createUser"),
      setAdmin: notFaked("auth.setAdmin"),
      startSession: notFaked("auth.startSession"),
      gitLogins: notFaked("auth.gitLogins"),
    },
    models: { offer: notFaked("models.offer") },
    store: memoryStore(),
    settings: { get: () => ({}) },
    config: { get: () => undefined, set: () => undefined, dir: "" },
    signal: new AbortController().signal,
    log: () => undefined,
    ...members,
  };
}

export function fakeSession(fields: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    environmentId: "environment-1",
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
    startedBy: null,
    online: true,
    waiting: false,
    ...fields,
  };
}

// A signed-in user calling a route, the context's owner unless the test
// names another. Not an admin unless the test says.
export function fakeUser({
  id = "owner",
  admin = false,
}: { readonly id?: string; readonly admin?: boolean } = {}): RouteCaller {
  return { kind: "user", actor: `user:${id}`, admin };
}

// A plugin's route that answers what it throws as the server does, for a
// test that calls the route itself.
export function served(route: PluginRoute): PluginRoute {
  return async (...request) => {
    try {
      return await route(...request);
    } catch (error) {
      if (error instanceof HttpError) {
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      }

      throw error;
    }
  };
}
