import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  KernelEvent,
  ServerPlugin,
  ServerPluginContext,
} from "@pi-cloud/plugins";
import type { Environment, Session, SessionEvent } from "@pi-cloud/protocol";
import { runAgent } from "./agent";
import { serve } from "./serve";
import { runnerCredentials } from "./testdata/runners";
import { firstUser } from "./testdata/sign-in";
import { readSse } from "./sse";

let root: string;
let faux: ReturnType<typeof fauxProvider>;
let server: ReturnType<typeof serve> | undefined;
let signedIn: () => Promise<string>;
let runners: ReturnType<typeof runnerCredentials>;
let runtime: ModelRuntime;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-cloud-plugins-")));
  faux = fauxProvider();
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

async function start(
  plugins: readonly ServerPlugin[],
  disabledPlugins: readonly string[] = [],
): Promise<void> {
  runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);
  const logs: string[] = [];

  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 100, offlineAfterMs: 1000 },
    agent: {
      provider: "local",
      dataDir: join(root, "local"),
      extensionPaths: [],
      folders: [root],
      models: { runtime, model: faux.getModel() },
    },
    plugins,
    disabledPlugins,
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
  runners = runnerCredentials(server, signedIn);
}

async function api(path: string, body?: unknown): Promise<Response> {
  if (!server) {
    throw new Error("server not started");
  }

  return fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: await signedIn(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function environmentReady(): Promise<void> {
  while (
    ((await (await api("/api/environments")).json()) as unknown[]).length === 0
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createSession(body: object = {}): Promise<Session> {
  await environmentReady();

  return (await (
    await api("/api/sessions", {
      workspace: { kind: "folder", path: root },
      ...body,
    })
  ).json()) as Session;
}

async function follow(
  sessionId: string,
  until: (events: readonly SessionEvent[]) => boolean,
): Promise<SessionEvent[]> {
  const controller = new AbortController();
  const response = await api(`/api/sessions/${sessionId}/events`);
  const events: SessionEvent[] = [];
  for await (const event of readSse(response)) {
    events.push(event as SessionEvent);
    if (until(events)) {
      break;
    }
  }

  controller.abort();

  return events;
}

const idle = (events: readonly SessionEvent[]): boolean =>
  events.at(-1)?.type === "session" &&
  events.some((e) => e.type === "session" && e.session.status === "idle");

const entriesInclude =
  (text: string) =>
  (events: readonly SessionEvent[]): boolean =>
    events.some((e) => e.type === "entry" && e.entry.includes(text));

test("serves a plugin's tools to the sessions they apply to and returns their result", async () => {
  const called: KernelEvent[] = [];

  await start([
    {
      name: "lookup",
      register: ({ tools, events }) => {
        events.subscribe("ToolCalled", (event) => {
          called.push(event);
        });

        tools.register({
          name: "lookup",
          description: "Looks a key up on the server",
          parameters: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
          },
          appliesTo: (session) => session.systemPrompt === null,
          run: async (input, caller) =>
            Promise.resolve({
              text: `${(input as { key: string }).key} is 42 for ${caller.actor}`,
              isError: false,
            }),
        });
      },
    },
  ]);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("lookup", { key: "answer" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("done")]),
  ]);

  const session = await createSession();
  await follow(session.id, idle);

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "look it up",
  });

  const events = await follow(session.id, entriesInclude('"done"'));

  expect(entriesInclude(`answer is 42 for session:${session.id}`)(events)).toBe(
    true,
  );

  expect(called).toMatchObject([
    { type: "ToolCalled", tool: "lookup", actor: `session:${session.id}` },
  ]);

  const toolless = await createSession({ systemPrompt: "No tools here." });

  const tools = await fetch(
    new URL(`/agent/sessions/${toolless.id}/tools?generation=1`, server?.url),
    {
      headers: {
        "pi-cloud-protocol": "2",
        authorization: `Bearer ${await runners.token("local")}`,
      },
    },
  );

  await follow(toolless.id, idle);

  expect(await tools.json()).toEqual([]);
});

test("serves a tool's exposure, namespace and hints to its sessions", async () => {
  const spec = {
    name: "keys_list",
    description: "Lists the keys on the server",
    parameters: { type: "object", properties: {} },
    exposure: "deferred",
    namespace: { name: "keys", description: "Keys on the server" },
    annotations: { readOnlyHint: true },
  } as const;

  await start([
    {
      name: "keys",
      register: ({ tools }) => {
        tools.register({
          ...spec,
          appliesTo: () => true,
          run: async () => Promise.resolve({ text: "none", isError: false }),
        });
      },
    },
  ]);

  const session = await createSession();

  const tools = await fetch(
    new URL(`/agent/sessions/${session.id}/tools?generation=1`, server?.url),
    {
      headers: {
        "pi-cloud-protocol": "2",
        authorization: `Bearer ${await runners.token("local")}`,
      },
    },
  );

  await follow(session.id, idle);

  expect(await tools.json()).toEqual([spec]);
});

test("starts a plugin's own Sessions on the Profile it provides, and no others", async () => {
  await start([
    {
      name: "meta",
      register: ({ owner, profiles, routes, sessions }) => {
        const profile = profiles.provide("assistant", {
          name: "Assistant",
          packages: [],
          agentsMd: "",
          systemMd: "",
          appendSystemMd: "You are the Pi Cloud assistant.",
          mcpServers: {},
          settings: {},
        });

        routes.handle((_request, path) => {
          const [last] = sessions.owned("chat");

          if (path === "again" && last !== undefined) {
            sessions.archive(last.id);
            sessions.unarchive(last.id);

            return Response.json(sessions.get(last.id));
          }

          return Response.json(
            sessions.start(
              {
                actor: `user:${owner}`,
                workspace: { kind: "folder", path: root },
                profile,
              },
              "chat",
            ),
          );
        });
      },
    },
  ]);

  faux.setResponses([
    (context) =>
      fauxAssistantMessage([
        fauxText(
          JSON.stringify(context.messages).includes(
            "You are the Pi Cloud assistant.",
          )
            ? "on the assistant Profile"
            : "on another Profile",
        ),
      ]),
  ]);

  await environmentReady();

  const owned = (await (
    await api("/api/plugins/meta/start", {})
  ).json()) as Session;

  await follow(owned.id, idle);

  await api(`/api/sessions/${owned.id}/commands`, {
    type: "message",
    text: "hello",
  });

  await follow(owned.id, entriesInclude("on the assistant Profile"));

  const anyone = await api("/api/sessions", {
    workspace: { kind: "folder", path: root },
    profile: owned.profileId,
  });

  const listed = (await (await api("/api/profiles")).json()) as {
    id: string;
  }[];

  const again = (await (
    await api("/api/plugins/meta/again", {})
  ).json()) as Session;

  const fork = await api(`/api/sessions/${owned.id}/fork`, {});

  const profiles = (await (await api("/api/profiles")).json()) as {
    id: string;
    isDefault: boolean;
  }[];

  expect(((await fork.json()) as Session).profileId).toBe(
    profiles.find(({ isDefault }) => isDefault)?.id ?? "",
  );

  expect(again.archivedAt).toBeNull();
  expect(anyone.status).toBe(400);
  expect(listed.map(({ id }) => id)).not.toContain(owned.profileId);
});

test("routes requests to a plugin that keeps its own tables", async () => {
  let refused = "";

  await start([
    {
      name: "notes",
      register: ({ routes, store }) => {
        store.exec("create table if not exists notes_items (text text)");
        try {
          store.exec("create table sessions_copy (id text)");
        } catch (error) {
          refused = String(error);
        }

        routes.handle(async (request, path) => {
          if (request.method === "POST" && path === "items") {
            const { text } = (await request.json()) as { text: string };
            store.run("insert into notes_items (text) values (?)", text);

            return new Response(null, { status: 204 });
          }

          return path === "items"
            ? Response.json(store.all("select text from notes_items"))
            : Response.json({ error: "not_found" }, { status: 404 });
        });
      },
    },
  ]);

  const added = await api("/api/plugins/notes/items", { text: "hello" });
  const items = await api("/api/plugins/notes/items");
  const unknown = await api("/api/plugins/nobody/items");

  expect(added.status).toBe(204);
  expect(await items.json()).toEqual([{ text: "hello" }]);
  expect(unknown.status).toBe(404);
  expect(refused).toContain("plugin notes may only create notes_ tables");

  expect(await (await api("/api/plugins")).json()).toMatchObject([
    { id: "notes", state: "on" },
  ]);
});

test("publishes kernel events and starts sessions for plugins", async () => {
  const seen: string[] = [];
  let started: Session | undefined;

  await start([
    {
      name: "starter",
      register: ({ events, sessions, routes }) => {
        for (const type of [
          "SessionCreated",
          "TurnStarted",
          "TurnEnded",
          "SessionArchived",
        ] as const) {
          events.subscribe(type, (event) => {
            seen.push(
              event.type === "SessionCreated"
                ? `${event.type} by ${event.actor}`
                : event.type,
            );
          });
        }

        routes.handle(() => {
          started = sessions.start({
            actor: "plugin:starter",
            workspace: { kind: "folder", path: root },
            systemPrompt: "You help the starter plugin.",
            firstMessage: "begin the work",
          });

          return Response.json(started);
        });
      },
    },
  ]);

  faux.setResponses([fauxAssistantMessage([fauxText("working on it")])]);
  await environmentReady();

  await api("/api/plugins/starter/start", {});
  const id = started?.id ?? "";
  const events = await follow(id, entriesInclude("working on it"));
  await follow(id, idle);
  await api(`/api/sessions/${id}/archive`, {});

  expect(entriesInclude("begin the work")(events)).toBe(true);

  expect(entriesInclude("You help the starter plugin.")(events)).toBe(true);

  expect(seen).toEqual([
    "SessionCreated by plugin:starter",
    "TurnStarted",
    "TurnEnded",
    "SessionArchived",
  ]);
});

test("lets a plugin archive and bring back only the Sessions it owns", async () => {
  let context: ServerPluginContext | undefined;
  const seen: string[] = [];

  await start([
    {
      name: "owner",
      register: (registered) => {
        context = registered;

        registered.events.subscribe("SessionUnarchived", ({ archivedAt }) => {
          seen.push(archivedAt);
        });
      },
    },
  ]);

  await environmentReady();

  const request = {
    actor: "plugin:owner",
    workspace: { kind: "folder", path: root },
  } as const;

  const owned = context?.sessions.start(request, "board");
  const other = context?.sessions.start(request);

  context?.sessions.archive(owned?.id ?? "");
  const archivedAt = context?.sessions.get(owned?.id ?? "")?.archivedAt;
  context?.sessions.unarchive(owned?.id ?? "");

  expect(archivedAt).toBeString();
  expect(seen).toEqual([archivedAt ?? ""]);
  expect(context?.sessions.get(owned?.id ?? "")?.archivedAt).toBeNull();

  expect(() => context?.sessions.archive(other?.id ?? "")).toThrow(
    "isn't owned by owner",
  );
});

test("tells a plugin why a message did not reach a session", async () => {
  let sessions: ServerPluginContext["sessions"] | undefined;

  await start([
    {
      name: "sender",
      register: (context) => {
        sessions = context.sessions;
      },
    },
  ]);

  const session = await createSession();
  await follow(session.id, idle);
  const reached = sessions?.notify(session.id, "a note", "plugin:sender");

  await api(`/api/sessions/${session.id}/archive`, {});
  const archived = sessions?.send(session.id, "hello", "plugin:sender");
  const unknown = sessions?.send("missing", "hello", "plugin:sender");

  const started = sessions?.start({
    actor: "plugin:sender",
    workspace: { kind: "folder", path: root },
  });

  const offline = sessions?.send(started?.id ?? "", "hello", "plugin:sender");

  expect([reached, archived, unknown, offline]).toEqual([
    { ok: true },
    { ok: false, reason: "archived" },
    { ok: false, reason: "not_found" },
    { ok: false, reason: "offline" },
  ]);
});

test("tells a plugin how many lines a session's transcript has", async () => {
  let sessions: ServerPluginContext["sessions"] | undefined;

  await start([
    {
      name: "counter",
      register: (context) => {
        sessions = context.sessions;
      },
    },
  ]);

  faux.setResponses([fauxAssistantMessage([fauxText("counted")])]);

  const session = await createSession();
  await follow(session.id, idle);

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "count with me",
  });

  await follow(session.id, entriesInclude('"counted"'));
  const lines = sessions?.transcript(session.id) ?? [];

  expect(lines.some((line) => line.includes('"counted"'))).toBe(true);
  expect(sessions?.transcriptLength(session.id)).toBe(lines.length);
  expect(sessions?.transcriptLength("missing")).toBe(0);
});

test("tells a plugin how many transcript lines a turn ended with", async () => {
  const ended: (number | undefined)[] = [];
  let sessions: ServerPluginContext["sessions"] | undefined;

  await start([
    {
      name: "turns",
      register: (context) => {
        sessions = context.sessions;

        context.events.subscribe("TurnEnded", ({ transcriptLength }) => {
          ended.push(transcriptLength);
        });
      },
    },
  ]);

  faux.setResponses([fauxAssistantMessage([fauxText("all done")])]);

  const session = await createSession();
  await follow(session.id, idle);

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "finish up",
  });

  await follow(session.id, entriesInclude('"all done"'));
  await follow(session.id, idle);

  expect(ended).toEqual([sessions?.transcriptLength(session.id)]);
  expect(sessions?.transcript(session.id).at(-1)).toContain('"all done"');
});

test("leaves out plugins that are turned off", async () => {
  let registered = false;

  await start(
    [
      {
        name: "off",
        register: () => {
          registered = true;
        },
      },
    ],
    ["off"],
  );

  expect(registered).toBe(false);

  expect(await (await api("/api/plugins")).json()).toMatchObject([
    { id: "off", state: "off" },
  ]);

  expect((await api("/api/plugins/off/anything")).status).toBe(404);
});

// A runner a plugin started, such as a pod, with the token the plugin gave it.
function startRunner(
  name: string,
  token: string,
  exitWhenIdleMs?: number,
): { readonly done: Promise<void>; readonly logs: string[] } {
  const logs: string[] = [];

  const done = runAgent({
    server: server?.url.href ?? "",
    provider: name,
    credential: { token },
    ...(exitWhenIdleMs !== undefined && { exitWhenIdleMs }),
    dataDir: join(root, name),
    extensionPaths: [],
    folders: [root],
    models: { runtime, model: faux.getModel() },
    log: (message) => {
      logs.push(message);
    },
    signal: AbortSignal.timeout(30_000),
  });

  return { done, logs };
}

async function poolEnvironment(): Promise<Environment> {
  await environmentReady();

  return (
    (await (await api("/api/environments", { name: "pool" })).json()) as {
      environment: Environment;
    }
  ).environment;
}

test("lets a plugin start a runner for a Session no runner can take, until it revokes it", async () => {
  let context: ServerPluginContext | undefined;

  await start([
    {
      name: "machines",
      register: (registered) => {
        context = registered;
      },
    },
  ]);

  const environment = await poolEnvironment();
  faux.setResponses([fauxAssistantMessage([fauxText("hi from a pod")])]);

  const session = await createSession({
    environment: environment.id,
    workspace: { kind: "folder", path: root },
  });

  expect(
    context?.environments.unplaced(environment.id).map(({ id }) => id),
  ).toEqual([session.id]);

  const pod = startRunner(
    "pod-1",
    context?.environments.runnerToken(environment.id, "pod-1") ?? "",
  );

  await follow(
    session.id,
    (events) =>
      idle(events) &&
      events.some((e) => e.type === "session" && e.session.runner === "pod-1"),
  );

  expect(context?.environments.unplaced(environment.id)).toEqual([]);

  await api(`/api/environments/${environment.id}/key`, {});

  await new Promise((resolve) => setTimeout(resolve, 500));

  expect(
    pod.logs.filter((line) => line.includes("let this runner go")),
  ).toEqual([]);

  context?.environments.revokeRunner(environment.id, "pod-1");

  const stopped = await pod.done.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(stopped).toEqual(new Error("the server let this runner go"));
});

test("stops a runner started to exit when idle once it runs no Session", async () => {
  let context: ServerPluginContext | undefined;

  await start([
    {
      name: "machines",
      register: (registered) => {
        context = registered;
      },
    },
  ]);

  const environment = await poolEnvironment();
  faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);

  const session = await createSession({
    environment: environment.id,
    workspace: { kind: "folder", path: root },
  });

  const pod = startRunner(
    "pod-1",
    context?.environments.runnerToken(environment.id, "pod-1") ?? "",
    300,
  );

  await follow(
    session.id,
    (events) =>
      idle(events) &&
      events.some((e) => e.type === "session" && e.session.runner === "pod-1"),
  );

  await new Promise((resolve) => setTimeout(resolve, 600));

  expect(pod.logs).not.toContain("no sessions for a while; stopping");

  await api(`/api/sessions/${session.id}/archive`, {});
  await pod.done;

  expect(pod.logs).toContain("no sessions for a while; stopping");
});
