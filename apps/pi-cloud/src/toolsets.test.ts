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
import { meta } from "@pi-cloud/meta/server";
import type { ServerPlugin } from "@pi-cloud/plugins";
import type {
  Prompt,
  Session,
  SessionEvent,
  UiAction,
} from "@pi-cloud/protocol";
import { serve, type ServeOptions } from "./serve";
import { firstUser } from "./testdata/sign-in";
import { readSse } from "./sse";

let root: string;
let faux: ReturnType<typeof fauxProvider>;
let server: ReturnType<typeof serve>;
let signedIn: () => Promise<string>;
let runtime: ModelRuntime;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-cloud-toolsets-")));
  faux = fauxProvider();

  runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);
  start();
});

function start(plugins?: ServeOptions["plugins"]): void {
  const logs: string[] = [];

  server = serve({
    ...(plugins && { plugins }),
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
    disabledPlugins: ["subagents"],
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
}

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

async function api(path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: await signedIn(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function json<T>(response: Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

async function environmentReady(): Promise<void> {
  while ((await json<unknown[]>(api("/api/environments"))).length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startMeta(text: string): Promise<Session> {
  await environmentReady();

  return json<Session>(api("/api/plugins/meta/sessions", { text }));
}

async function follow(
  sessionId: string,
  until: (events: readonly SessionEvent[]) => boolean,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of readSse(
    await api(`/api/sessions/${sessionId}/events`),
  )) {
    events.push(event as SessionEvent);
    if (until(events)) {
      break;
    }
  }

  return events;
}

const entriesInclude =
  (text: string) =>
  (events: readonly SessionEvent[]): boolean =>
    events.some((e) => e.type === "entry" && e.entry.includes(text));

const prompts = (events: readonly SessionEvent[]): Prompt[] =>
  events.flatMap((e) =>
    e.type === "live" && e.event.type === "prompt" ? [e.event.prompt] : [],
  );

const transcriptOf = (events: readonly SessionEvent[]): string =>
  events.flatMap((e) => (e.type === "entry" ? [e.entry] : [])).join("\n");

const call = (
  name: string,
  input: Parameters<typeof fauxToolCall>[1],
): ReturnType<typeof fauxAssistantMessage> =>
  fauxAssistantMessage([fauxToolCall(name, input)], { stopReason: "toolUse" });

async function answerNext(
  sessionId: string,
  allowed: boolean,
): Promise<Prompt> {
  const [asked] = prompts(
    await follow(sessionId, (all) => prompts(all).length > 0),
  );

  if (asked === undefined) {
    throw new Error("no prompt");
  }

  await api(`/api/sessions/${sessionId}/commands`, {
    type: "answer",
    id: asked.id,
    value: allowed,
  });

  return asked;
}

test("starts a Session from a meta-session through the Sessions route once the user allows it", async () => {
  faux.setResponses([
    call("sessions_start", { workspace: { kind: "folder", path: root } }),
    fauxAssistantMessage([fauxText("started it")]),
  ]);

  const metaSession = await startMeta("Start a Session in my folder");
  const asked = await answerNext(metaSession.id, true);
  const events = await follow(metaSession.id, entriesInclude("started it"));

  const [started] = await json<Session[]>(api("/api/sessions"));

  const profiles = await json<{ id: string; isDefault: boolean }[]>(
    api("/api/profiles"),
  );

  expect(asked.title).toBe("Allow sessions_start?");
  expect(started?.workspace).toEqual({ kind: "folder", path: root });

  expect(started?.profileId).toBe(
    profiles.find(({ isDefault }) => isDefault)?.id,
  );

  expect(transcriptOf(events)).toContain(started?.id ?? "missing");
});

test("hands the route's own validation error back to the model", async () => {
  faux.setResponses([
    call("sessions_start", { workspace: { kind: "folder" } }),
    fauxAssistantMessage([fauxText("that failed")]),
  ]);

  const metaSession = await startMeta("Start a Session");
  await answerNext(metaSession.id, true);
  const events = await follow(metaSession.id, entriesInclude("that failed"));

  expect(transcriptOf(events)).toContain("workspace must be a folder");
  expect(await json<Session[]>(api("/api/sessions"))).toEqual([]);
});

test("finds deferred tools through tool_search, and asks before changing an Environment", async () => {
  await environmentReady();
  const [environment] = await json<{ id: string }[]>(api("/api/environments"));

  const update = { id: environment?.id ?? "", setupScript: "echo ready" };

  faux.setResponses([
    call("environments_update", update),
    call("tool_search", { query: "change an Environment setup script" }),
    call("environments_update", update),
    fauxAssistantMessage([fauxText("changed it")]),
  ]);

  const metaSession = await startMeta("Set up my Environment");
  const asked = await answerNext(metaSession.id, true);
  const events = await follow(metaSession.id, entriesInclude("changed it"));

  const [changed] = await json<{ setupScript: string }[]>(
    api("/api/environments"),
  );

  expect(asked.title).toBe("Allow environments_update?");
  expect(transcriptOf(events)).toContain("Tool environments_update not found");
  expect(changed?.setupScript).toBe("echo ready");
});

test("keeps an Environment's new key out of the meta-session", async () => {
  faux.setResponses([
    call("tool_search", { query: "create an Environment" }),
    call("environments_create", { name: "lab" }),
    fauxAssistantMessage([fauxText("created it")]),
  ]);

  const metaSession = await startMeta("Create an Environment called lab");
  const events = await follow(metaSession.id, entriesInclude("created it"));

  const names = (await json<{ name: string }[]>(api("/api/environments"))).map(
    ({ name }) => name,
  );

  expect(names).toContain("lab");
  expect(transcriptOf(events)).toContain("Replace key");
  expect(transcriptOf(events)).not.toContain("pck_");
});

test("creates a Project through the Projects plugin's route", async () => {
  faux.setResponses([
    call("projects_create", {
      name: "Shop",
      repositories: ["https://example.com/shop.git"],
    }),
    fauxAssistantMessage([fauxText("created the Project")]),
  ]);

  const metaSession = await startMeta("Make a Project for my shop");
  await answerNext(metaSession.id, true);
  await follow(metaSession.id, entriesInclude("created the Project"));

  const projects = await json<{ name: string }[]>(
    api("/api/plugins/projects/projects"),
  );

  expect(projects.map(({ name }) => name)).toEqual(["Shop"]);
});

test("gives an ordinary Session none of the toolsets", async () => {
  faux.setResponses([
    call("sessions_list", {}),
    fauxAssistantMessage([fauxText("all done")]),
  ]);

  await environmentReady();

  const session = await json<Session>(
    api("/api/sessions", {
      workspace: { kind: "folder", path: root },
      firstMessage: "List the Sessions",
    }),
  );

  const events = await follow(session.id, entriesInclude("all done"));

  expect(transcriptOf(events)).toContain("Tool sessions_list not found");
});

test("shows a Profile's MCP servers by name only", async () => {
  await api("/api/profiles", {
    name: "With MCP",
    mcpServers: { github: { env: { GITHUB_TOKEN: "token-in-env" } } },
  });

  faux.setResponses([
    call("tool_search", { query: "list Profiles" }),
    call("profiles_list", {}),
    fauxAssistantMessage([fauxText("listed them")]),
  ]);

  const metaSession = await startMeta("Which Profiles do I have?");
  const events = await follow(metaSession.id, entriesInclude("listed them"));

  expect(transcriptOf(events)).toContain('\\"mcpServers\\":[\\"github\\"]');
  expect(transcriptOf(events)).not.toContain("token-in-env");
});

test("keeps a plugin's tool inside the plugin's own routes", async () => {
  const probe: ServerPlugin = {
    name: "probe",
    register: (context) => {
      context.routes.handle((_request, path) =>
        path === "text"
          ? new Response("plain words")
          : Response.json({ reached: "probe" }),
      );

      context.toolsets.register({
        namespace: { name: "probe" },
        tools: [
          {
            name: "run",
            description: "Runs an item",
            parameters: { type: "object" },
            exposure: "direct",
            annotations: { readOnlyHint: true },
            request: (input) => ({
              method: "GET",
              path: `items/${String(input["id"])}`,
            }),
          },
          {
            name: "text",
            description: "Answers in plain text",
            parameters: { type: "object" },
            exposure: "direct",
            annotations: { readOnlyHint: true },
            request: () => ({ method: "GET", path: "text" }),
          },
        ],
      });
    },
  };

  await server.stop();
  start([meta, probe]);

  faux.setResponses([
    call("probe_run", { id: "../../../profiles" }),
    call("probe_run", { id: "%2e%2e/%2e%2e/%2e%2e/profiles" }),
    call("probe_run", { id: "7" }),
    call("probe_text", {}),
    fauxAssistantMessage([fauxText("tried them")]),
  ]);

  const metaSession = await startMeta("Run the items");

  const transcript = transcriptOf(
    await follow(metaSession.id, entriesInclude("tried them")),
  );

  expect(transcript.match(/isn't one of its routes/g)).toHaveLength(2);
  expect(transcript).toContain("reached");
  expect(transcript).not.toContain("isDefault");
  expect(transcript).toMatch(/"plain words".*"isError":false/);
});

test("refuses a plugin's toolset in a namespace the kernel has", async () => {
  const squatter: ServerPlugin = {
    name: "squatter",
    register: (context) => {
      context.toolsets.register({
        namespace: { name: "sessions" },
        tools: [],
      });
    },
  };

  await server.stop();
  start([meta, squatter]);

  const plugins = await json<{ id: string; state: string; error?: string }[]>(
    api("/api/plugins"),
  );

  expect(plugins.find(({ id }) => id === "squatter")).toMatchObject({
    state: "failed",
    error: "toolset sessions belongs to kernel",
  });
});

const uiActions = (events: readonly SessionEvent[]): UiAction[] =>
  events.flatMap((e) =>
    e.type === "live" && e.event.type === "ui_action" ? [e.event.action] : [],
  );

test("opens what a tool started or asked for in the browsers watching, once", async () => {
  faux.setResponses([
    call("sessions_start", { workspace: { kind: "folder", path: root } }),
    call("projects_create", {
      name: "Shop",
      repositories: ["https://example.com/shop.git"],
    }),
    fauxAssistantMessage([fauxText("all opened")]),
  ]);

  const metaSession = await startMeta("Start things");
  const answered = new Set<string>();

  const events = await follow(metaSession.id, (all) => {
    for (const prompt of prompts(all).filter(({ id }) => !answered.has(id))) {
      answered.add(prompt.id);

      void api(`/api/sessions/${metaSession.id}/commands`, {
        type: "answer",
        id: prompt.id,
        value: true,
      });
    }

    return entriesInclude("all opened")(all);
  });

  const [started] = await json<Session[]>(api("/api/sessions"));

  const [project] = await json<{ id: string }[]>(
    api("/api/plugins/projects/projects"),
  );

  expect(uiActions(events)).toEqual([
    { kind: "open", route: started?.id ?? "", label: "the new Session" },
    {
      kind: "open",
      route: `plugin/projects/${project?.id ?? ""}`,
      label: "“Shop”",
    },
  ]);

  const replayed = await follow(metaSession.id, entriesInclude("all opened"));

  expect(uiActions(replayed)).toEqual([]);
});

test("opens a Session on request without asking, and only routes of the app", async () => {
  const probe: ServerPlugin = {
    name: "probe",
    register: (context) => {
      context.routes.handle(() => Response.json({}));

      context.toolsets.register({
        namespace: { name: "probe" },
        tools: [
          {
            name: "escape",
            description: "Opens a route outside the app",
            parameters: { type: "object" },
            exposure: "direct",
            annotations: { readOnlyHint: true },
            request: () => ({ method: "GET", path: "x" }),
            opens: () => ({ route: "../../elsewhere", label: "elsewhere" }),
          },
        ],
      });
    },
  };

  await server.stop();
  start([meta, probe]);
  await environmentReady();

  const target = await json<Session>(
    api("/api/sessions", { workspace: { kind: "folder", path: root } }),
  );

  faux.setResponses([
    call("probe_escape", {}),
    call("sessions_open", { id: target.id }),
    fauxAssistantMessage([fauxText("opened it")]),
  ]);

  const metaSession = await startMeta("Show me that Session");
  const events = await follow(metaSession.id, entriesInclude("opened it"));

  expect(prompts(events)).toEqual([]);

  expect(uiActions(events)).toEqual([
    { kind: "open", route: target.id, label: "the Session" },
  ]);
});

test("gives a meta-session no tools that reach the runner's files or shell", async () => {
  let declared = "";

  faux.setResponses([
    (context) => {
      declared = JSON.stringify(context);

      return fauxAssistantMessage([fauxText("looked")]);
    },
  ]);

  const metaSession = await startMeta("What can you do?");
  await follow(metaSession.id, entriesInclude("looked"));

  expect(declared).toContain('{"name":"sessions_list"');

  for (const tool of ["read", "bash", "edit", "write"]) {
    expect(declared).not.toContain(`{"name":"${tool}"`);
  }
});
