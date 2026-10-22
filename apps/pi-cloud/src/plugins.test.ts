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
import type { Session, SessionEvent } from "@pi-cloud/protocol";
import { serve } from "./serve";
import { readSse } from "./sse";

let root: string;
let faux: ReturnType<typeof fauxProvider>;
let server: ReturnType<typeof serve> | undefined;

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
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 100, offlineAfterMs: 1000 },
    agent: {
      provider: "local",
      dataDir: join(root, "local"),
      agentDir: join(root, "pi"),
      extensionPaths: [],
      folders: [root],
      models: { runtime, model: faux.getModel() },
    },
    plugins,
    disabledPlugins,
    log: () => undefined,
  });
}

async function api(path: string, body?: unknown): Promise<Response> {
  if (!server) {
    throw new Error("server not started");
  }

  return fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    ...(body !== undefined && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
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
    { headers: { "pi-cloud-protocol": "1", "pi-cloud-provider": "local" } },
  );

  await follow(toolless.id, idle);

  expect(await tools.json()).toEqual([]);
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
  expect(await (await api("/api/plugins")).json()).toEqual(["notes"]);
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
  expect(await (await api("/api/plugins")).json()).toEqual([]);
  expect((await api("/api/plugins/off/anything")).status).toBe(404);
});
