import { afterEach, beforeEach, expect, test } from "bun:test";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  CreateSession,
  Provider,
  Session,
  SessionEvent,
} from "@pi-cloud/protocol";
import { runAgent } from "./agent";
import { serve } from "./serve";
import { readSse } from "./sse";

let root: string;
let server: ReturnType<typeof serve>;
let faux: ReturnType<typeof fauxProvider>;
let runtime: ModelRuntime;
let agents: (() => Promise<void>)[];
let laptop: () => Promise<void>;
let agentLogs: string[];
let serverLogs: string[];

function startAgent(
  provider: string,
  extensionPaths: readonly string[] = [],
): () => Promise<void> {
  const controller = new AbortController();

  const done = runAgent({
    server: server.url.href,
    provider,
    dataDir: join(root, provider),
    agentDir: join(root, "pi"),
    extensionPaths,
    folders: [root, join(root, "origin")],
    models: { runtime, model: faux.getModel() },
    log: (message, fields) => {
      agentLogs.push(`${message} ${JSON.stringify(fields)}`);
    },
    signal: controller.signal,
  });

  const stop = async (): Promise<void> => {
    controller.abort();
    await done;
  };

  agents.push(stop);

  return stop;
}

function startServer(builtInProvider?: string): ReturnType<typeof serve> {
  return serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 100, offlineAfterMs: 200 },
    ...(builtInProvider !== undefined && {
      agent: {
        provider: builtInProvider,
        dataDir: join(root, builtInProvider),
        agentDir: join(root, "pi"),
        extensionPaths: [],
        folders: [],
        models: { runtime, model: faux.getModel() },
      },
    }),
    log: (message, fields) => {
      serverLogs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });
}

beforeEach(async () => {
  // macOS tmpdir is a symlink, and the shell reports the resolved path.
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-cloud-")));
  serverLogs = [];

  faux = fauxProvider({
    models: [{ id: "faux-small" }, { id: "faux-large" }],
  });

  runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);
  server = startServer();
  agents = [];
  agentLogs = [];
  laptop = startAgent("laptop");
});

afterEach(async () => {
  await Promise.all(agents.map(async (stop) => stop()));
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

async function api(path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    ...(body !== undefined && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

async function createSession(
  provider: string,
  workspace: CreateSession["workspace"] = { kind: "folder", path: root },
): Promise<Session> {
  return (await (
    await api("/api/sessions", { provider, workspace })
  ).json()) as Session;
}

async function watch(
  sessionId: string,
  headers: Record<string, string> = {},
): Promise<
  (
    until: (events: readonly SessionEvent[]) => boolean,
  ) => Promise<SessionEvent[]>
> {
  const controller = new AbortController();

  const response = await fetch(
    new URL(`/api/sessions/${sessionId}/events`, server.url),
    { signal: controller.signal, headers },
  );

  return async (until) => {
    const events: SessionEvent[] = [];
    for await (const event of readSse(response)) {
      events.push(event as SessionEvent);
      if (until(events)) {
        break;
      }
    }

    controller.abort();

    return events;
  };
}

async function follow(
  sessionId: string,
  until: (events: readonly SessionEvent[]) => boolean,
): Promise<SessionEvent[]> {
  return (await watch(sessionId))(until);
}

const status =
  (wanted: Session["status"]) =>
  (events: readonly SessionEvent[]): boolean =>
    events.at(-1)?.type === "session" &&
    events.some((e) => e.type === "session" && e.session.status === wanted);

function roles(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== "entry") {
      return [];
    }

    const entry = JSON.parse(event.entry) as { message?: { role: string } };

    return entry.message?.role ?? [];
  });
}

test("chats with a session on an agent and replays it later", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("hello from pi")])]);
  const session = await createSession("laptop");
  expect(session.status).toBe("queued");

  await follow(session.id, status("idle"));

  const sent = await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "hi",
  });

  expect(sent.status).toBe(202);

  const live = await follow(session.id, (events) =>
    roles(events).includes("assistant"),
  );

  const replay = await follow(
    session.id,
    (events) => roles(events).length === roles(live).length,
  );

  expect(roles(replay).slice(-2)).toEqual(["user", "assistant"]);

  expect(replay.filter((e) => e.type === "entry")).toEqual(
    live.filter((e) => e.type === "entry"),
  );
});

test("delivers a retried message once and a new one with the same text", async () => {
  faux.setResponses([
    fauxAssistantMessage([fauxText("first")]),
    fauxAssistantMessage([fauxText("second")]),
    fauxAssistantMessage([fauxText("third")]),
  ]);

  const session = await createSession("laptop");
  await follow(session.id, status("idle"));

  for (const [requestId, text] of [
    ["a", "one"],
    ["a", "one"],
    ["b", "one"],
    ["c", "two"],
  ]) {
    const sent = await api(`/api/sessions/${session.id}/commands`, {
      type: "message",
      text,
      requestId,
    });

    expect(sent.status).toBe(202);
  }

  const events = await follow(session.id, (seen) =>
    userTexts(seen).includes("two"),
  );

  expect(userTexts(events)).toEqual(["one", "one", "two"]);
});

function userTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== "entry") {
      return [];
    }

    const { message } = JSON.parse(event.entry) as {
      message?: { role: string; content: string | { text?: string }[] };
    };

    if (message?.role !== "user") {
      return [];
    }

    return typeof message.content === "string"
      ? message.content
      : message.content.map((part) => part.text ?? "").join("");
  });
}

test("resumes the event stream after the last received line", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("hello again")])]);
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "hi",
  });

  const live = await follow(session.id, (events) =>
    roles(events).includes("assistant"),
  );

  const entries = live.filter((e) => e.type === "entry");
  const seen = entries.at(-2);
  if (seen?.type !== "entry") {
    throw new Error("expected at least two entries");
  }

  const resumed = await (
    await watch(session.id, { "last-event-id": String(seen.line) })
  )((events) => events.some((e) => e.type === "entry"));

  expect(resumed[0]?.type).toBe("session");
  expect(resumed.filter((e) => e.type === "entry")).toEqual(entries.slice(-1));
});

test("labels transcript events with their line", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("labelled")])]);
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "hi",
  });

  await follow(session.id, (events) => roles(events).includes("assistant"));

  const response = await api(`/api/sessions/${session.id}/events`);

  const reader = response.body
    ?.pipeThrough(new TextDecoderStream())
    .getReader();

  let text = "";
  while (reader && !text.includes("id: 0\n")) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    text += value;
  }

  await reader?.cancel();
  expect(text).toContain('id: 0\ndata: {"type":"entry","line":0');
});

test("streams text as it is generated", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("streamed reply")])]);
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));

  const watching = await watch(session.id);

  const done = watching(
    (events) =>
      events.some(
        (e) =>
          e.type === "live" &&
          e.event.type === "status" &&
          e.event.status === "idle",
      ) && roles(events).includes("assistant"),
  );

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "hi",
  });

  const events = await done;

  const text = events
    .flatMap((e) =>
      e.type === "live" && e.event.type === "text" ? e.event.delta : [],
    )
    .join("");

  expect(text).toBe("streamed reply");
});

test("rejects commands for a session whose provider is not connected", async () => {
  const session = await createSession("vm");

  const sent = await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "hi",
  });

  expect(sent.status).toBe(409);
  expect(await sent.json()).toEqual({ error: "offline" });
});

async function asAgent(
  provider: string,
  path: string,
  body?: unknown,
  version = "1",
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "pi-cloud-protocol": version,
      "pi-cloud-provider": provider,
      "content-type": "application/json",
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

test("keeps transcript lines once and in order across resends", async () => {
  const session = await createSession("vm");

  const work = (await (
    await asAgent("vm", "/agent/work", { running: [], folders: [], models: [] })
  ).json()) as {
    start: { generation: number }[];
  };

  const generation = work.start[0]?.generation;
  const path = `/agent/sessions/${session.id}/transcript`;

  const first = await asAgent("vm", path, {
    generation,
    start: 0,
    lines: ["a", "b"],
  });

  const overlap = await asAgent("vm", path, {
    generation,
    start: 1,
    lines: ["b", "c"],
  });

  const gap = await asAgent("vm", path, { generation, start: 5, lines: ["f"] });

  const replay = await follow(
    session.id,
    (events) => events.filter((e) => e.type === "entry").length === 3,
  );

  expect(await first.json()).toEqual({ acked: 2 });
  expect(await overlap.json()).toEqual({ acked: 3 });
  expect(await gap.json()).toEqual({ acked: 3 });

  expect(replay.flatMap((e) => (e.type === "entry" ? e.entry : []))).toEqual([
    "a",
    "b",
    "c",
  ]);
});

test("drops messages from an older generation", async () => {
  const session = await createSession("vm");
  await asAgent("vm", "/agent/work", { running: [], folders: [], models: [] });

  const stale = await asAgent(
    "vm",
    `/agent/sessions/${session.id}/transcript`,
    {
      generation: 0,
      start: 0,
      lines: ["old"],
    },
  );

  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: "stale_generation" });
});

test("rejects agent requests with another protocol version or provider", async () => {
  const session = await createSession("vm");

  const version = await asAgent(
    "vm",
    "/agent/work",
    { running: [], folders: [], models: [] },
    "99",
  );

  const provider = await asAgent(
    "laptop-2",
    `/agent/sessions/${session.id}/live`,
    {
      generation: 0,
      events: [],
    },
  );

  expect(version.status).toBe(400);
  expect(provider.status).toBe(404);
});

test("rejects malformed requests with 400", async () => {
  const session = await createSession("vm");

  const malformed = await fetch(new URL("/api/sessions", server.url), {
    method: "POST",
    body: "{not json",
  });

  const noGeneration = await asAgent(
    "vm",
    `/agent/sessions/${session.id}/commands`,
  );

  const noWorkspace = await api("/api/sessions", { provider: "vm" });

  const unknownWorkspace = await api("/api/sessions", {
    provider: "vm",
    workspace: { kind: "volume", path: root },
  });

  const negativeStart = await asAgent(
    "vm",
    `/agent/sessions/${session.id}/transcript`,
    {
      generation: 0,
      start: -1,
      lines: ["x"],
    },
  );

  expect(malformed.status).toBe(400);
  expect(noWorkspace.status).toBe(400);
  expect(unknownWorkspace.status).toBe(400);
  expect(noGeneration.status).toBe(400);
  expect(negativeStart.status).toBe(400);
});

test("aborts a running turn and stores the session as idle", async () => {
  faux.setResponses([
    async (_context, options) => {
      await new Promise((resolve) => {
        options?.signal?.addEventListener("abort", resolve);
      });

      return fauxAssistantMessage([fauxText("too late")]);
    },
  ]);

  const session = await createSession("laptop");
  await follow(session.id, status("idle"));
  const watching = await watch(session.id);

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "hi",
  });

  await watching(status("running"));

  const aborted = await api(`/api/sessions/${session.id}/commands`, {
    type: "abort",
  });

  await follow(session.id, status("idle"));

  const stored = (await (
    await api(`/api/sessions/${session.id}`)
  ).json()) as Session;

  expect(aborted.status).toBe(202);
  expect(stored.status).toBe("idle");
});

test("rejects commands once the agent stops", async () => {
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));

  await laptop();

  const sent = await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "hi",
  });

  expect(sent.status).toBe(409);
});

test("restarts an interrupted session as a new attempt with its transcript", async () => {
  faux.setResponses([
    fauxAssistantMessage([fauxText("first")]),
    (context) =>
      fauxAssistantMessage([
        fauxText(
          JSON.stringify(context.messages).includes('"one"')
            ? "remembers one"
            : "forgot",
        ),
      ]),
  ]);

  const session = await createSession("laptop");
  await follow(session.id, status("idle"));

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "one",
  });

  await follow(session.id, (events) => roles(events).includes("assistant"));

  await laptop();

  await follow(session.id, (events) =>
    events.some((e) => e.type === "session" && !e.session.online),
  );

  startAgent("laptop");

  await follow(
    session.id,
    (events) =>
      events.at(-1)?.type === "session" &&
      events.some(
        (e) =>
          e.type === "session" &&
          e.session.generation === 2 &&
          e.session.status === "idle",
      ),
  );

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "two",
  });

  const replay = await follow(
    session.id,
    (events) => roles(events).filter((r) => r === "assistant").length === 2,
  );

  const stored = (await (
    await api(`/api/sessions/${session.id}`)
  ).json()) as Session;

  expect(roles(replay).filter((r) => r !== "system")).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);

  expect(
    replay.some((e) => e.type === "entry" && e.entry.includes("remembers one")),
  ).toBe(true);

  expect(stored.interruptedAt).not.toBeNull();
  expect(stored.online).toBe(true);
});

test("marks a session failed when its host cannot start", async () => {
  startAgent("broken", [join(root, "missing-extension.ts")]);
  const session = await createSession("broken");

  await follow(session.id, status("failed"));

  const stored = (await (
    await api(`/api/sessions/${session.id}`)
  ).json()) as Session;

  expect(stored).toMatchObject({ status: "failed", generation: 1 });
  expect(stored.error).toContain("missing-extension.ts");
});

test("keeps a session running through a provider outage", async () => {
  const session = await createSession("vm");
  const running = [{ sessionId: session.id, generation: 1 }];
  await asAgent("vm", "/agent/work", { running: [], folders: [], models: [] });

  const offline = await follow(session.id, (events) =>
    events.some((e) => e.type === "session" && !e.session.online),
  );

  await asAgent("vm", "/agent/work", { running, folders: [], models: [] });

  const stored = (await (
    await api(`/api/sessions/${session.id}`)
  ).json()) as Session;

  expect(offline.at(-1)).toMatchObject({
    type: "session",
    session: { status: "starting", online: false },
  });

  expect(stored).toMatchObject({
    status: "starting",
    generation: 1,
    online: true,
    interruptedAt: null,
  });
});

test("takes a session back when another poll claims it", async () => {
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));

  await asAgent("laptop", "/agent/work", {
    running: [],
    folders: [],
    models: [],
  });

  const events = await follow(
    session.id,
    (seen) =>
      seen.at(-1)?.type === "session" &&
      seen.some(
        (e) =>
          e.type === "session" &&
          e.session.generation === 3 &&
          e.session.status === "idle",
      ),
  );

  expect(events.at(-1)).toMatchObject({
    type: "session",
    session: { status: "idle", generation: 3 },
  });
});

test("closes the command stream of an interrupted attempt", async () => {
  const session = await createSession("vm");
  await asAgent("vm", "/agent/work", { running: [], folders: [], models: [] });

  const commands = await asAgent(
    "vm",
    `/agent/sessions/${session.id}/commands?generation=1`,
  );

  await asAgent("vm", "/agent/work", { running: [], folders: [], models: [] });
  const received: unknown[] = [];
  for await (const command of readSse(commands)) {
    received.push(command);
  }

  expect(commands.status).toBe(200);
  expect(received).toEqual([]);
});

async function openTerminal(sessionId: string): Promise<{
  readonly socket: WebSocket;
  readonly output: (until: string) => Promise<string>;
  readonly closed: Promise<void>;
}> {
  const url = new URL(
    `/api/sessions/${sessionId}/terminal?cols=80&rows=24`,
    server.url,
  );

  url.protocol = "ws:";
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const decoder = new TextDecoder();
  let text = "";
  let changed = (): void => undefined;

  socket.addEventListener("message", (event: MessageEvent) => {
    text += decoder.decode(event.data as ArrayBuffer, { stream: true });
    changed();
  });

  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", () => {
      resolve();
    });
  });

  await new Promise((resolve) => {
    socket.addEventListener("open", resolve);
  });

  return {
    socket,
    closed,
    output: async (until) => {
      while (!text.includes(until)) {
        await new Promise<void>((resolve) => {
          changed = resolve;
        });
      }

      return text;
    },
  };
}

const encoder = new TextEncoder();

const webSocketUpgrade = {
  upgrade: "websocket",
  connection: "Upgrade",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "sec-websocket-version": "13",
};

async function stalledTerminal(
  sessionId: string,
  input: string,
): Promise<Socket> {
  const socket = connect(Number(server.url.port), "127.0.0.1");

  socket.write(
    [
      `GET /api/sessions/${sessionId}/terminal?cols=80&rows=24 HTTP/1.1`,
      `Host: ${server.url.host}`,
      ...Object.entries(webSocketUpgrade).map(([k, v]) => `${k}: ${v}`),
      "",
      "",
    ].join("\r\n"),
  );

  await once(socket, "data");

  const payload = encoder.encode(input);
  const mask = [1, 2, 3, 4];

  socket.write(
    Uint8Array.from([
      0x82,
      0x80 | payload.length,
      ...mask,
      ...payload.map((byte, i) => byte ^ (mask[i % 4] ?? 0)),
    ]),
  );

  socket.pause();

  return socket;
}

test("runs a shell in the session's directory over a terminal socket", async () => {
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));
  const terminal = await openTerminal(session.id);

  terminal.socket.send(encoder.encode("echo dir=$(pwd) sum=$((40+2))\n"));
  const output = await terminal.output("sum=42");

  expect(output).toContain(`dir=${root}`);
});

async function gitRepository(): Promise<string> {
  const repository = join(root, "origin");
  const git = promisify(execFile);
  await git("git", ["init", "--initial-branch=main", repository]);
  await writeFile(join(repository, "README.md"), "hello\n");
  await git("git", ["-C", repository, "add", "."]);

  await git("git", [
    "-C",
    repository,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "first",
  ]);

  return repository;
}

test("runs a session in a fresh clone on the server's own provider", async () => {
  await server.stop();
  server = startServer("cloud");
  const repository = await gitRepository();
  const session = await createSession("cloud", { kind: "clone", repository });
  const branch = `pi-cloud/${session.id.slice(0, 8)}`;

  expect(session.workspace).toEqual({ kind: "clone", repository, branch });

  await follow(session.id, status("idle"));
  const terminal = await openTerminal(session.id);

  terminal.socket.send(
    encoder.encode(
      "echo dir=$(pwd) branch=$(git branch --show-current) sum=$((40+2))\n",
    ),
  );

  const output = await terminal.output("sum=42");

  expect(output).toContain(
    `dir=${join(root, "cloud", "workspaces", session.id)}`,
  );

  expect(output).toContain(`branch=${branch}`);
});

test("lists each provider with the folders and models its agent offers", async () => {
  let providers: Provider[] = [];
  while (!providers.some((p) => p.name === "laptop")) {
    providers = (await (await api("/api/providers")).json()) as Provider[];
  }

  expect(providers).toMatchObject([
    { name: "laptop", online: true, folders: [root, join(root, "origin")] },
  ]);

  expect(providers[0]?.models).toContainEqual({
    provider: faux.getModel().provider,
    id: "faux-large",
  });
});

test("runs a session on the model it was created with", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
  const model = { provider: faux.getModel().provider, id: "faux-large" };

  const session = (await (
    await api("/api/sessions", {
      provider: "laptop",
      workspace: { kind: "folder", path: root },
      model,
    })
  ).json()) as Session;

  expect(session.model).toEqual(model);
  await follow(session.id, status("idle"));

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "hi",
  });

  const events = await follow(session.id, (seen) =>
    roles(seen).includes("assistant"),
  );

  const replies = events.flatMap((event) => {
    if (event.type !== "entry") {
      return [];
    }

    const { message } = JSON.parse(event.entry) as {
      message?: { role: string; model?: string };
    };

    return message?.role === "assistant" ? [message.model] : [];
  });

  expect(replies).toEqual(["faux-large"]);
});

test("fails a session whose model its provider cannot use", async () => {
  const session = (await (
    await api("/api/sessions", {
      provider: "laptop",
      workspace: { kind: "folder", path: root },
      model: { provider: "nowhere", id: "none" },
    })
  ).json()) as Session;

  const events = await follow(session.id, status("failed"));
  const last = events.at(-1);

  expect(last?.type === "session" && last.session.error).toContain(
    "model not available: nowhere/none",
  );
});

test("rejects a session request with a malformed model", async () => {
  const response = await api("/api/sessions", {
    provider: "laptop",
    workspace: { kind: "folder", path: root },
    model: "faux-large",
  });

  expect(response.status).toBe(400);
});

test("runs a laptop session in its own worktree of a listed checkout", async () => {
  const checkout = await gitRepository();

  const session = await createSession("laptop", {
    kind: "worktree",
    path: checkout,
  });

  const branch = `pi-cloud/${session.id.slice(0, 8)}`;

  expect(session.workspace).toEqual({
    kind: "worktree",
    path: checkout,
    branch,
  });

  await follow(session.id, status("idle"));
  const terminal = await openTerminal(session.id);

  terminal.socket.send(
    encoder.encode(
      "echo dir=$(pwd) branch=$(git branch --show-current) sum=$((40+2))\n",
    ),
  );

  const output = await terminal.output("sum=42");

  expect(output).toContain(
    `dir=${join(root, "laptop", "workspaces", session.id)}`,
  );

  expect(output).toContain(`branch=${branch}`);
});

test("marks a session failed when its folder is not listed", async () => {
  const unlisted = join(root, "laptop");

  const session = await createSession("laptop", {
    kind: "folder",
    path: unlisted,
  });

  await follow(session.id, status("failed"));

  const stored = (await (
    await api(`/api/sessions/${session.id}`)
  ).json()) as Session;

  expect(stored.error).toContain(`folder not allowed: ${unlisted}`);
});

test("marks a session failed when its repository cannot be cloned", async () => {
  await server.stop();
  server = startServer("cloud");

  const session = await createSession("cloud", {
    kind: "clone",
    repository: join(root, "missing"),
  });

  await follow(session.id, status("failed"));

  const stored = (await (
    await api(`/api/sessions/${session.id}`)
  ).json()) as Session;

  expect(stored.error).toContain("git clone failed");
});

test("resizes the terminal", async () => {
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));
  const terminal = await openTerminal(session.id);

  terminal.socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
  terminal.socket.send(encoder.encode("echo size=$(stty size)\n"));

  expect(await terminal.output("size=30 100")).toContain("size=30 100");
});

test("closes the terminal socket when the shell exits", async () => {
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));
  const terminal = await openTerminal(session.id);

  terminal.socket.send(encoder.encode("exit\n"));
  await terminal.closed;

  expect(terminal.socket.readyState).toBe(WebSocket.CLOSED);
});

test("refuses a terminal for a session whose agent is gone", async () => {
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));
  await laptop();

  const response = await fetch(
    new URL(`/api/sessions/${session.id}/terminal`, server.url),
    { headers: webSocketUpgrade },
  );

  expect(response.status).toBe(409);
});

test("serves the web UI with its bundled script", async () => {
  const page = await api("/");
  const html = await page.text();
  const script = /<script[^>]*src="([^"]+)"/.exec(html)?.[1] ?? "";
  const bundle = await api(script);

  expect(page.headers.get("content-type")).toContain("text/html");
  expect(bundle.status).toBe(200);
  expect(await bundle.text()).toContain("/api/sessions");
});

test("replays open prompts to a client that connects later", async () => {
  const session = await createSession("vm");
  await asAgent("vm", "/agent/work", { running: [], folders: [], models: [] });

  const prompt = {
    type: "prompt",
    prompt: { id: "p1", kind: "confirm", title: "Deploy?", message: "Sure?" },
  } as const;

  await asAgent("vm", `/agent/sessions/${session.id}/live`, {
    generation: 1,
    events: [prompt],
  });

  const open = await follow(session.id, (events) =>
    events.some((e) => e.type === "live"),
  );

  await asAgent("vm", `/agent/sessions/${session.id}/live`, {
    generation: 1,
    events: [{ type: "prompt_end", id: "p1" }],
  });

  const later = await watch(session.id);

  await asAgent("vm", `/agent/sessions/${session.id}/live`, {
    generation: 1,
    events: [{ type: "status", status: "idle" }],
  });

  const answered = await later((events) =>
    events.some((e) => e.type === "live"),
  );

  expect(open.at(-1)).toEqual({ type: "live", event: prompt });

  expect(answered.filter((e) => e.type === "live")).toEqual([
    { type: "live", event: { type: "status", status: "idle" } },
  ]);
});

test("replays the current extension status, widgets and title to a client that connects later", async () => {
  const session = await createSession("vm");
  await asAgent("vm", "/agent/work", { running: [], folders: [], models: [] });

  await asAgent("vm", `/agent/sessions/${session.id}/live`, {
    generation: 1,
    events: [
      { type: "extension_status", key: "build", text: "1 running" },
      { type: "extension_status", key: "lint", text: "clean" },
      { type: "extension_status", key: "build", text: "2 running" },
      { type: "extension_status", key: "lint", text: null },
      {
        type: "widget",
        key: "todo",
        lines: ["first"],
        placement: "aboveEditor",
      },
      { type: "widget", key: "gone", lines: ["x"], placement: "belowEditor" },
      { type: "widget", key: "gone", lines: null, placement: "belowEditor" },
      { type: "title", title: "my session" },
      { type: "editor_text", text: "draft" },
    ],
  });

  const later = await follow(session.id, (events) =>
    events.some((e) => e.type === "live" && e.event.type === "title"),
  );

  expect(later.filter((e) => e.type === "live")).toEqual([
    {
      type: "live",
      event: { type: "extension_status", key: "build", text: "2 running" },
    },
    {
      type: "live",
      event: {
        type: "widget",
        key: "todo",
        lines: ["first"],
        placement: "aboveEditor",
      },
    },
    { type: "live", event: { type: "title", title: "my session" } },
  ]);
});

test("rejects requests from other sites", async () => {
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));

  const fromSite = async (
    path: string,
    headers: Record<string, string>,
  ): Promise<number> =>
    (
      await fetch(new URL(path, server.url), {
        method: path.endsWith("/commands") ? "POST" : "GET",
        headers,
        ...(path.endsWith("/commands") && {
          body: JSON.stringify({ type: "message", text: "hi" }),
        }),
      })
    ).status;

  const statuses = [
    await fromSite(`/api/sessions/${session.id}/commands`, {
      origin: "https://evil.example",
    }),
    await fromSite(`/api/sessions/${session.id}/terminal`, {
      ...webSocketUpgrade,
      origin: "https://evil.example",
    }),
    await fromSite("/api/sessions", { host: "evil.example" }),
    await fromSite("/api/sessions", { origin: server.url.origin }),
  ];

  expect(statuses).toEqual([403, 403, 403, 200]);
});

test("does not open a terminal for a request that is not a WebSocket", async () => {
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));

  const response = await api(`/api/sessions/${session.id}/terminal`);
  await new Promise((resolve) => setTimeout(resolve, 200));

  expect(response.status).toBe(400);

  expect(
    agentLogs.filter((line) => line.startsWith("terminal opened")),
  ).toEqual([]);
});

test("ignores terminal control frames that are not resizes", async () => {
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));
  const terminal = await openTerminal(session.id);

  terminal.socket.send("not json");
  terminal.socket.send(JSON.stringify({ type: "resize", cols: -1, rows: 5 }));
  terminal.socket.send(JSON.stringify({ type: "resize", cols: 90, rows: 20 }));
  terminal.socket.send(encoder.encode("echo size=$(stty size)\n"));

  expect(await terminal.output("size=20 90")).toContain("size=20 90");
});

test("does not let a host take another session's terminal", async () => {
  const first = await createSession("laptop");
  const second = await createSession("laptop");
  await follow(first.id, status("idle"));
  const secondReady = await follow(second.id, status("idle"));
  const generation = secondReady.findLast((e) => e.type === "session");
  await openTerminal(first.id);

  const opened = async (): Promise<string | undefined> => {
    for (;;) {
      const line = agentLogs.find((l) => l.startsWith("terminal opened"));
      if (line !== undefined) {
        return line;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  const line = await opened();
  const terminalId = /"terminalId":"([^"]+)"/.exec(line ?? "")?.[1] ?? "";

  const url = new URL(
    `/agent/sessions/${second.id}/terminals/${terminalId}?generation=${String(generation?.type === "session" ? generation.session.generation : 0)}`,
    server.url,
  );

  const response = await fetch(url, {
    headers: {
      "pi-cloud-protocol": "1",
      "pi-cloud-provider": "laptop",
      ...webSocketUpgrade,
    },
  });

  expect(response.status).toBe(404);
});

test("closes a terminal whose browser stops reading while others keep working", async () => {
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));
  const healthy = await openTerminal(session.id);

  const stalled = await stalledTerminal(
    session.id,
    "head -c 100000000 /dev/zero | tr '\\0' x\n",
  );

  while (!serverLogs.some((line) => line.includes("browser fell behind"))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  healthy.socket.send(encoder.encode("echo still=$((40+2))\n"));
  const output = await healthy.output("still=42");
  stalled.destroy();

  expect(output).toContain("still=42");
}, 30_000);
