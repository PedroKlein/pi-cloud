import { afterEach, beforeEach, expect, test } from "bun:test";
import { once } from "node:events";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
  Environment,
  Session,
  SessionEvent,
  Work,
} from "@pi-cloud/protocol";
import { runAgent } from "./agent";
import { serve } from "./serve";
import { readSse } from "./sse";
import { runnerCredentials } from "./testdata/runners";
import { firstUserCookie, setupTokenOf } from "./testdata/sign-in";

let root: string;
let server: ReturnType<typeof serve>;
let faux: ReturnType<typeof fauxProvider>;
let runtime: ModelRuntime;
let agents: (() => Promise<void>)[];
let laptop: () => Promise<void>;
let agentLogs: string[];
let serverLogs: string[];
let cookie: Promise<string> | undefined;
let runners: ReturnType<typeof runnerCredentials>;

async function startAgent(
  provider: string,
  extensionPaths: readonly string[] = [],
  serverUrl: URL = server.url,
  environment = provider,
): Promise<() => Promise<void>> {
  const controller = new AbortController();

  const done = runAgent({
    server: serverUrl.href,
    provider,
    credential: { key: await runners.key(environment) },
    dataDir: join(root, provider),
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
  const started = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 100, offlineAfterMs: 200 },
    ...(builtInProvider !== undefined && {
      agent: {
        provider: builtInProvider,
        dataDir: join(root, builtInProvider),
        extensionPaths: [],
        folders: [],
        models: { runtime, model: faux.getModel() },
      },
    }),
    log: (message, fields) => {
      serverLogs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  cookie = undefined;
  runners = runnerCredentials(started, signedIn);

  return started;
}

// The Cookie header of the current server's first user.
async function signedIn(): Promise<string> {
  cookie ??= firstUserCookie(fetch, server.url, setupTokenOf(serverLogs));

  return cookie;
}

beforeEach(async () => {
  // macOS tmpdir is a symlink, and the shell reports the resolved path.
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-cloud-")));
  serverLogs = [];

  faux = fauxProvider({
    models: [{ id: "faux-small" }, { id: "faux-large", reasoning: true }],
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
  laptop = await startAgent("laptop");
});

afterEach(async () => {
  await Promise.all(agents.map(async (stop) => stop()));
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

// The server sees an agent's connections close a moment after it stops.
async function untilOffline(provider: string): Promise<void> {
  while (
    ((await (await api("/api/environments")).json()) as Environment[]).some(
      (environment) => environment.provider === provider && environment.online,
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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

// The server creates a provider's Environment on its first poll. Providers
// without a running agent poll once here, as a test agent would.
async function environmentOf(provider: string): Promise<string> {
  const find = async (): Promise<Environment | undefined> =>
    ((await (await api("/api/environments")).json()) as Environment[]).find(
      (environment) => environment.provider === provider,
    );

  let found = await find();
  if (!found) {
    await asAgent(provider, "/agent/work", {
      running: [],
      folders: [],
      models: [],
    });

    found = await find();
  }

  if (!found) {
    throw new Error(`no environment for ${provider}`);
  }

  return found.id;
}

async function createSession(
  provider: string,
  workspace: CreateSession["workspace"] = { kind: "folder", path: root },
): Promise<Session> {
  return (await (
    await api("/api/sessions", {
      environment: await environmentOf(provider),
      workspace,
    })
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
    {
      signal: controller.signal,
      headers: { cookie: await signedIn(), ...headers },
    },
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

test("reports itself healthy", async () => {
  const response = await api("/healthz");

  expect(response.status).toBe(200);

  expect(await response.json()).toEqual({
    status: "ok",
    version: expect.any(String) as unknown,
    pi: expect.any(String) as unknown,
  });
});

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

test("lists the slash commands Pi knows, also for a browser that joins later", async () => {
  await mkdir(join(root, ".pi", "prompts"), { recursive: true });

  await writeFile(
    join(root, ".pi", "prompts", "review.md"),
    "---\ndescription: Review the diff\n---\nReview the current diff.\n",
  );

  const session = await createSession("laptop");

  const [asked] = (
    await follow(session.id, (seen) =>
      seen.some(
        (event) => event.type === "live" && event.event.type === "prompt",
      ),
    )
  ).flatMap((event) =>
    event.type === "live" && event.event.type === "prompt"
      ? [event.event.prompt]
      : [],
  );

  await api(`/api/sessions/${session.id}/commands`, {
    type: "answer",
    id: asked?.id,
    value: "Trust it",
  });

  const hasReview = (events: readonly SessionEvent[]): boolean =>
    events.some(
      (event) =>
        event.type === "live" &&
        event.event.type === "commands" &&
        event.event.commands.some(({ name }) => name === "review"),
    );

  await follow(session.id, hasReview);
  const replay = await follow(session.id, hasReview);

  const commands = replay.flatMap((event) =>
    event.type === "live" && event.event.type === "commands"
      ? event.event.commands
      : [],
  );

  expect(commands).toContainEqual({
    name: "review",
    description: "Review the diff",
    source: "prompt",
  });
});

// A 1×1 transparent PNG.
const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("sends a message's images to the model and keeps them in the transcript", async () => {
  let seen: unknown;

  faux.setResponses([
    (context) => {
      seen = context.messages.at(-1);

      return fauxAssistantMessage([fauxText("a pixel")]);
    },
  ]);

  const session = await createSession("laptop");
  await follow(session.id, status("idle"));

  const sent = await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "what is this?",
    images: [{ mimeType: "image/png", data: pixel }],
  });

  expect(sent.status).toBe(202);

  const events = await follow(session.id, (seenEvents) =>
    roles(seenEvents).includes("assistant"),
  );

  const image = { type: "image", mimeType: "image/png", data: pixel };

  expect(seen).toMatchObject({
    role: "user",
    content: expect.arrayContaining([image]) as unknown,
  });

  const entries = events.flatMap((event) =>
    event.type === "entry" ? [JSON.parse(event.entry) as unknown] : [],
  );

  expect(entries).toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([image]) as unknown,
      }) as unknown,
    }),
  );
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

test("rejects commands a browser may not send", async () => {
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));

  const statuses = await Promise.all(
    [
      { type: "message" },
      { type: "message", text: "hi", delivery: "later" },
      { type: "unqueue", text: "hi", delivery: "later" },
      { type: "unqueue", delivery: "steer" },
      { type: "unqueue", text: "hi", delivery: "steer", sendNow: "yes" },
      { type: "set_model", model: "openai/gpt-5" },
      { type: "set_model", model: { provider: "openai" } },
      { type: "set_thinking", level: "huge" },
      { type: "ui_columns", columns: 0 },
      { type: "ui_columns", columns: 12.5 },
      { type: "message", text: "hi", images: "cat.png" },
      {
        type: "message",
        text: "hi",
        images: [{ mimeType: "image/svg+xml", data: pixel }],
      },
      {
        type: "message",
        text: "hi",
        images: [{ mimeType: "image/png", data: "not base64!" }],
      },
      {
        type: "message",
        text: "hi",
        images: Array.from({ length: 6 }, () => ({
          mimeType: "image/png",
          data: pixel,
        })),
      },
      {
        type: "message",
        text: "hi",
        images: [
          {
            mimeType: "image/png",
            data: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"),
          },
        ],
      },
      { type: "answer", value: "yes" },
      { type: "terminal", terminalId: "t1", cols: 80, rows: 24 },
      { type: "reboot" },
      "abort",
    ].map(async (command) => {
      const response = await api(
        `/api/sessions/${session.id}/commands`,
        command,
      );

      return response.status;
    }),
  );

  expect(statuses).toEqual(statuses.map(() => 400));
});

test("takes only answers shaped like a prompt's answer", async () => {
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));

  const answer = async (value: unknown): Promise<number> => {
    const response = await api(`/api/sessions/${session.id}/commands`, {
      type: "answer",
      id: "prompt-1",
      value,
    });

    return response.status;
  };

  const accepted = await Promise.all(
    [
      "yes",
      true,
      null,
      {
        answers: [
          {
            id: "db",
            type: "choice",
            selections: [
              {
                value: "sqlite",
                label: "SQLite",
                custom: false,
                annotation: null,
              },
            ],
          },
          { id: "name", type: "text", text: "widgets" },
          { id: "size", type: "number", value: 40 },
        ],
        note: "no rush",
      },
    ].map(answer),
  );

  const rejected = await Promise.all(
    [
      undefined,
      42,
      [],
      { answers: "x", note: null },
      { answers: [] },
      { answers: [{ id: "name", type: "text" }], note: null },
      { answers: [{ id: "size", type: "number", value: "40" }], note: null },
      {
        answers: [{ id: "db", type: "choice", selections: [{ value: "a" }] }],
        note: null,
      },
    ].map(answer),
  );

  expect(accepted).toEqual([202, 202, 202, 202]);
  expect(rejected).toEqual(Array.from({ length: 8 }, () => 400));
});

async function asAgent(
  provider: string,
  path: string,
  body?: unknown,
  version = "2",
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "pi-cloud-protocol": version,
      authorization: `Bearer ${await runners.token(provider)}`,
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

test("titles a session with its first user message until Pi names it", async () => {
  const session = await createSession("vm");

  const work = (await (
    await asAgent("vm", "/agent/work", { running: [], folders: [], models: [] })
  ).json()) as {
    start: { generation: number }[];
  };

  const generation = work.start[0]?.generation;
  const path = `/agent/sessions/${session.id}/transcript`;

  const titled = async (): Promise<string | null> =>
    (
      (await (await api(`/api/sessions/${session.id}`)).json()) as {
        title: string | null;
      }
    ).title;

  expect(await titled()).toBeNull();

  const entry = (value: unknown): string => JSON.stringify(value);

  await asAgent("vm", path, {
    generation,
    start: 0,
    lines: [
      entry({ type: "session", version: 3 }),
      entry({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: " fix the login bug " }],
        },
      }),
      entry({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "and the tests" }],
        },
      }),
    ],
  });

  expect(await titled()).toBe("fix the login bug");

  await asAgent("vm", path, {
    generation,
    start: 3,
    lines: [entry({ type: "session_info", name: "Login fix" })],
  });

  expect(await titled()).toBe("Login fix");
});

test("follows the model Pi switches a session to", async () => {
  const session = await createSession("vm");

  const work = (await (
    await asAgent("vm", "/agent/work", { running: [], folders: [], models: [] })
  ).json()) as {
    start: { generation: number }[];
  };

  const model = async (): Promise<unknown> =>
    (
      (await (await api(`/api/sessions/${session.id}`)).json()) as {
        model: unknown;
      }
    ).model;

  const before = await model();

  await asAgent("vm", `/agent/sessions/${session.id}/transcript`, {
    generation: work.start[0]?.generation,
    start: 0,
    lines: [
      JSON.stringify({ type: "session", version: 3 }),
      JSON.stringify({
        type: "model_change",
        provider: "google",
        modelId: "gemini-3.5-flash-lite",
      }),
    ],
  });

  expect(before).not.toEqual({
    provider: "google",
    id: "gemini-3.5-flash-lite",
  });

  expect(await model()).toEqual({
    provider: "google",
    id: "gemini-3.5-flash-lite",
  });
});

test("keeps the last character whole when it shortens a long title", async () => {
  const session = await createSession("vm");

  const work = (await (
    await asAgent("vm", "/agent/work", { running: [], folders: [], models: [] })
  ).json()) as {
    start: { generation: number }[];
  };

  const generation = work.start[0]?.generation;
  const path = `/agent/sessions/${session.id}/transcript`;

  const titled = async (): Promise<string | null> =>
    (
      (await (await api(`/api/sessions/${session.id}`)).json()) as {
        title: string | null;
      }
    ).title;

  const events = await watch(session.id);

  await asAgent("vm", path, {
    generation,
    start: 0,
    lines: [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: `${"a".repeat(79)}😀 and more` }],
        },
      }),
    ],
  });

  const live = await events((seen) =>
    seen.some((e) => e.type === "session" && e.session.title !== null),
  );

  expect(
    live.flatMap((e) => (e.type === "session" ? e.session.title : [])),
  ).toContain(`${"a".repeat(79)}😀`);

  expect(await titled()).toBe(`${"a".repeat(79)}😀`);

  await asAgent("vm", path, {
    generation,
    start: 1,
    lines: [
      JSON.stringify({ type: "session_info", name: `${"b".repeat(79)}🚀🚀` }),
    ],
  });

  expect(await titled()).toBe(`${"b".repeat(79)}🚀`);
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

test("drops transcript lines for a session no attempt has claimed", async () => {
  const session = await createSession("vm");

  const early = await asAgent(
    "vm",
    `/agent/sessions/${session.id}/transcript`,
    { generation: 0, start: 0, lines: ["early"] },
  );

  expect(early.status).toBe(409);
});

test("keeps transcript lines the current attempt sends after its session is archived", async () => {
  const session = await createSession("vm");

  const work = (await (
    await asAgent("vm", "/agent/work", { running: [], folders: [], models: [] })
  ).json()) as {
    start: { generation: number }[];
  };

  const generation = work.start[0]?.generation ?? 0;
  const path = `/agent/sessions/${session.id}/transcript`;
  await asAgent("vm", path, { generation, start: 0, lines: ["a"] });
  await api(`/api/sessions/${session.id}/archive`, {});

  const late = await asAgent("vm", path, {
    generation,
    start: 1,
    lines: ["b"],
  });

  const older = await asAgent("vm", path, {
    generation: generation - 1,
    start: 2,
    lines: ["old"],
  });

  expect(late.status).toBe(200);
  expect(await late.json()).toEqual({ acked: 2 });
  expect(older.status).toBe(409);

  const replay = await follow(
    session.id,
    (events) => events.filter((e) => e.type === "entry").length === 2,
  );

  expect(replay.flatMap((e) => (e.type === "entry" ? e.entry : []))).toEqual([
    "a",
    "b",
  ]);
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
    headers: { cookie: await signedIn() },
    body: "{not json",
  });

  const noGeneration = await asAgent(
    "vm",
    `/agent/sessions/${session.id}/commands`,
  );

  const environment = await environmentOf("vm");
  const noWorkspace = await api("/api/sessions", { environment });

  const unknownWorkspace = await api("/api/sessions", {
    environment,
    workspace: { kind: "volume", path: root },
  });

  const optionStartPoint = await api("/api/sessions", {
    environment,
    workspace: {
      kind: "clone",
      repository: root,
      startPoint: "--upload-pack=x",
    },
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
  expect(optionStartPoint.status).toBe(400);
  expect(noGeneration.status).toBe(400);
  expect(negativeStart.status).toBe(400);
});

test("rejects agent bodies outside the protocol with 400", async () => {
  const session = await createSession("vm");

  const work = (await (
    await asAgent("vm", "/agent/work", { running: [], folders: [], models: [] })
  ).json()) as {
    start: { generation: number }[];
  };

  const generation = work.start[0]?.generation;
  const base = `/agent/sessions/${session.id}`;

  const claimed = (await (
    await api(`/api/sessions/${session.id}`)
  ).json()) as Session;

  const statuses = await Promise.all(
    [
      asAgent("vm", `${base}/live`, {
        generation,
        events: [{ type: "status", status: "bogus" }],
      }),
      asAgent("vm", `${base}/live`, { generation, events: [null] }),
      asAgent("vm", `${base}/live`, { events: [] }),
      asAgent("vm", `${base}/live`, {
        generation,
        events: [{ type: "status", status: "idle", transcriptLength: -1 }],
      }),
      asAgent("vm", `${base}/live`, {
        generation,
        events: [{ type: "status", status: "idle", transcriptLength: "3" }],
      }),
      asAgent("vm", `${base}/transcript`, { generation, start: 0, lines: [1] }),
      asAgent("vm", `${base}/failed`, { generation, error: 5 }),
      asAgent("vm", `${base}/workspace`, { generation, outcome: "lost" }),
      asAgent("vm", `${base}/workspace`, { generation, outcome: "removed" }),
      asAgent("vm", `${base}/workspace`, { outcome: "kept", reason: "dirty" }),
      asAgent("vm", `${base}/tool-calls`, { generation, name: "lookup" }),
      asAgent("vm", "/agent/work", {}),
      asAgent("vm", "/agent/work", {
        running: [{ sessionId: session.id }],
        folders: [],
        models: [],
      }),
    ].map(async (response) => (await response).status),
  );

  const after = (await (
    await api(`/api/sessions/${session.id}`)
  ).json()) as Session;

  expect(statuses).toEqual(Array.from({ length: 13 }, () => 400));
  expect(after.status).toBe(claimed.status);
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
  await untilOffline("laptop");

  await follow(session.id, (events) =>
    events.some((e) => e.type === "session" && !e.session.online),
  );

  const sent = await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "hi",
  });

  expect(sent.status).toBe(409);
  expect(await sent.json()).toEqual({ error: "offline" });
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

  await startAgent("laptop");

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

test("restarts a session on a runner without its files from the server's transcript", async () => {
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

  // Like another runner, which never had the Session's files.
  await rm(join(root, "laptop", "sessions", session.id), {
    recursive: true,
    force: true,
  });

  await startAgent("laptop");

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
  await startAgent("broken", [join(root, "missing-extension.ts")]);
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

async function openTerminal(
  sessionId: string,
  terminalId?: string,
): Promise<{
  readonly socket: WebSocket;
  readonly output: (until: string) => Promise<string>;
  readonly closed: Promise<void>;
}> {
  const url = new URL(
    `/api/sessions/${sessionId}/terminal?cols=80&rows=24`,
    server.url,
  );

  if (terminalId !== undefined) {
    url.searchParams.set("terminal", terminalId);
  }

  url.protocol = "ws:";
  const socket = new WebSocket(url, { headers: { cookie: await signedIn() } });
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
      `Cookie: ${await signedIn()}`,
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

test("opens a terminal on a runner named apart from its Environment", async () => {
  await startAgent("mac-1", [], server.url, "pool");

  while (
    !((await (await api("/api/environments")).json()) as Environment[]).some(
      (environment) => environment.provider === "pool" && environment.online,
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const session = await createSession("pool");
  await follow(session.id, status("idle"));
  const terminal = await openTerminal(session.id);

  terminal.socket.send(encoder.encode("echo sum=$((40+2))\n"));

  expect(await terminal.output("sum=42")).toContain("sum=42");
});

async function updateEnvironment(
  provider: string,
  update: Record<string, unknown>,
): Promise<Response> {
  return fetch(
    new URL(`/api/environments/${await environmentOf(provider)}`, server.url),
    {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: await signedIn() },
      body: JSON.stringify(update),
    },
  );
}

test("runs the Environment's setup script once and gives its Sessions its variables and secrets", async () => {
  const setupLog = join(root, "setup.log");

  const updated = await updateEnvironment("laptop", {
    setupScript: 'echo "ran with $TOKEN" >> "$SETUP_LOG"',
    variables: { SETUP_LOG: setupLog },
    secrets: { TOKEN: "s3cret" },
  });

  const first = await createSession("laptop");
  await follow(first.id, status("idle"));
  const second = await createSession("laptop");
  await follow(second.id, status("idle"));

  const terminal = await openTerminal(second.id);
  terminal.socket.send(encoder.encode("echo token=$TOKEN.\n"));
  const output = await terminal.output("token=s3cret.");

  const [environment] = (await (
    await api("/api/environments")
  ).json()) as Environment[];

  expect(updated.status).toBe(200);
  expect(output).toContain("token=s3cret.");
  expect(await readFile(setupLog, "utf8")).toBe("ran with s3cret\n");

  expect(environment).toMatchObject({
    setupScript: 'echo "ran with $TOKEN" >> "$SETUP_LOG"',
    variables: { SETUP_LOG: setupLog },
    secrets: ["TOKEN"],
  });

  expect(JSON.stringify(environment)).not.toContain("s3cret");
});

test("marks a session failed with the output of its failed setup script", async () => {
  await updateEnvironment("laptop", {
    setupScript: 'echo "cannot install tools with $TOKEN"; exit 3',
    secrets: { TOKEN: "s3cret" },
  });

  const session = await createSession("laptop");
  await follow(session.id, status("failed"));

  const stored = (await (
    await api(`/api/sessions/${session.id}`)
  ).json()) as Session;

  expect(stored.error).toContain("exited with code 3");
  expect(stored.error).toContain("cannot install tools with ***");
  expect(stored.error).not.toContain("s3cret");
});

test("fails a container Session on an agent with no Linux binary to run in it", async () => {
  await updateEnvironment("laptop", { isolation: "container" });

  const session = await createSession("laptop");
  await follow(session.id, status("failed"));

  const stored = (await (
    await api(`/api/sessions/${session.id}`)
  ).json()) as Session;

  expect(stored.error).toContain("--session-binary");
});

test("rejects an Environment update with a malformed or huge variable", async () => {
  const badName = await updateEnvironment("laptop", {
    variables: { "NOT-A-NAME": "x" },
  });

  const tooLarge = await updateEnvironment("laptop", {
    secrets: { BIG: "x".repeat(64 * 1024) },
  });

  const badIsolation = await updateEnvironment("laptop", { isolation: "vm" });
  const badImage = await updateEnvironment("laptop", { image: "--privileged" });

  expect(badName.status).toBe(400);
  expect(badIsolation.status).toBe(400);
  expect(badImage.status).toBe(400);
  expect(tooLarge.status).toBe(400);
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

test("keeps the server's own runner when its Environment gets a key", async () => {
  await server.stop();
  server = startServer("cloud");
  await environmentOf("cloud");
  await runners.key("cloud");

  const session = await createSession("cloud", {
    kind: "clone",
    repository: await gitRepository(),
  });

  await follow(session.id, status("idle"));

  expect(serverLogs.some((line) => line.includes("environment key"))).toBe(
    true,
  );
});

test("lists an Environment for each provider with the folders and models its agent offers", async () => {
  let environments: Environment[] = [];
  while (!environments.some((e) => e.provider === "laptop" && e.online)) {
    environments = (await (
      await api("/api/environments")
    ).json()) as Environment[];
  }

  expect(environments).toMatchObject([
    {
      id: expect.any(String) as unknown,
      name: "laptop",
      provider: "laptop",
      ownerId: "local",
      online: true,
      folders: [root, join(root, "origin")],
    },
  ]);

  expect(environments[0]?.models).toContainEqual({
    provider: faux.getModel().provider,
    id: "faux-large",
  });
});

test("runs a session on the model it was created with", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
  const model = { provider: faux.getModel().provider, id: "faux-large" };

  const session = (await (
    await api("/api/sessions", {
      environment: await environmentOf("laptop"),
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
      environment: await environmentOf("laptop"),
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
    environment: await environmentOf("laptop"),
    workspace: { kind: "folder", path: root },
    model: "faux-large",
  });

  expect(response.status).toBe(400);
});

test("starts a session at the reasoning level it was created with", async () => {
  const session = (await (
    await api("/api/sessions", {
      environment: await environmentOf("laptop"),
      workspace: { kind: "folder", path: root },
      model: { provider: faux.getModel().provider, id: "faux-large" },
      thinking: "high",
    })
  ).json()) as Session;

  expect(session.thinking).toBe("high");

  await follow(session.id, (seen) =>
    seen.some(
      (event) =>
        event.type === "live" &&
        event.event.type === "settings" &&
        event.event.thinking === "high",
    ),
  );

  const unknown = await api("/api/sessions", {
    workspace: { kind: "folder", path: root },
    thinking: "huge",
  });

  expect(unknown.status).toBe(400);
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

test("forks a session into a new one that remembers its chat and starts from its branch", async () => {
  // Near the length titles are cut to, so the fork's longer one must survive.
  const first = `one ${"x".repeat(72)}`;

  faux.setResponses([
    fauxAssistantMessage([fauxText("first")]),
    (context) =>
      fauxAssistantMessage([
        fauxText(
          JSON.stringify(context.messages).includes(first)
            ? "remembers one"
            : "forgot",
        ),
      ]),
  ]);

  const checkout = await gitRepository();

  const source = await createSession("laptop", {
    kind: "worktree",
    path: checkout,
  });

  await follow(source.id, status("idle"));

  await api(`/api/sessions/${source.id}/commands`, {
    type: "message",
    text: first,
  });

  await follow(source.id, (events) => roles(events).includes("assistant"));

  const response = await api(`/api/sessions/${source.id}/fork`, {});
  const fork = (await response.json()) as Session;

  await follow(fork.id, status("idle"));

  await api(`/api/sessions/${fork.id}/commands`, {
    type: "message",
    text: "two",
  });

  const replay = await follow(
    fork.id,
    (events) => roles(events).filter((r) => r === "assistant").length === 2,
  );

  const missing = await api("/api/sessions/nope/fork", {});

  const stored = (await (
    await api(`/api/sessions/${fork.id}`)
  ).json()) as Session;

  expect(response.status).toBe(201);

  expect(fork.workspace).toEqual({
    kind: "worktree",
    path: checkout,
    branch: `pi-cloud/${fork.id.slice(0, 8)}`,
    startPoint: `pi-cloud/${source.id.slice(0, 8)}`,
  });

  expect(
    replay.some((e) => e.type === "entry" && e.entry.includes("remembers one")),
  ).toBe(true);

  expect(missing.status).toBe(404);
  expect(stored.title).toBe(`${first} (fork)`);
});

test("marks a session failed when its folder is not listed", async () => {
  const unlisted = await realpath(
    await mkdtemp(join(tmpdir(), "pi-cloud-unlisted-")),
  );

  const session = await createSession("laptop", {
    kind: "folder",
    path: unlisted,
  });

  await follow(session.id, status("failed"));

  const stored = (await (
    await api(`/api/sessions/${session.id}`)
  ).json()) as Session;

  expect(stored.error).toContain(`folder not allowed: ${unlisted}`);
  await rm(unlisted, { recursive: true });
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

test("keeps a shell running after its socket closes and replays its output to the next one", async () => {
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));
  const first = await openTerminal(session.id, "kept");

  first.socket.send(encoder.encode("KEPT=yes; echo first=$((1+1))\n"));
  await first.output("first=2");
  first.socket.close();
  await first.closed;

  const surfaces = await follow(session.id, (events) =>
    events.some((e) => e.type === "live" && e.event.type === "terminals"),
  );

  const again = await openTerminal(session.id, "kept");

  expect(await again.output("first=2")).toContain("first=2");

  again.socket.send(encoder.encode("echo kept=$KEPT\n"));

  expect(await again.output("kept=yes")).toContain("kept=yes");

  expect(surfaces.filter((e) => e.type === "live").at(-1)).toEqual({
    type: "live",
    event: {
      type: "terminals",
      terminals: [{ id: "kept", label: "Terminal 1" }],
    },
  });
});

test("ends a shell when its tab is closed", async () => {
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));
  const first = await openTerminal(session.id, "closing");

  first.socket.send(encoder.encode("KEPT=yes; echo ready\n"));
  await first.output("ready");
  first.socket.send(JSON.stringify({ type: "close" }));
  await first.closed;

  const again = await openTerminal(session.id, "closing");
  again.socket.send(encoder.encode("echo value=${KEPT:-none}\n"));

  expect(await again.output("value=none")).toContain("value=none");
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
  await untilOffline("laptop");

  await follow(session.id, (events) =>
    events.some((e) => e.type === "session" && !e.session.online),
  );

  const response = await fetch(
    new URL(`/api/sessions/${session.id}/terminal`, server.url),
    { headers: { ...webSocketUpgrade, cookie: await signedIn() } },
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

test("marks a session as waiting on a person while one of its prompts is open", async () => {
  const session = await createSession("vm");
  await asAgent("vm", "/agent/work", { running: [], folders: [], models: [] });

  const waiting = async (): Promise<boolean> =>
    ((await (await api(`/api/sessions/${session.id}`)).json()) as Session)
      .waiting;

  const prompted = await watch(session.id);

  await asAgent("vm", `/agent/sessions/${session.id}/live`, {
    generation: 1,
    events: [
      {
        type: "prompt",
        prompt: {
          id: "p1",
          kind: "confirm",
          title: "Deploy?",
          message: "Sure?",
        },
      },
    ],
  });

  await prompted((events) =>
    events.some((e) => e.type === "session" && e.session.waiting),
  );

  expect(await waiting()).toBe(true);

  await asAgent("vm", `/agent/sessions/${session.id}/live`, {
    generation: 1,
    events: [{ type: "prompt_end", id: "p1" }],
  });

  expect(await waiting()).toBe(false);
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
      { type: "footer", lines: ["main"] },
      { type: "header", lines: ["welcome"] },
      { type: "header", lines: null },
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
    { type: "live", event: { type: "footer", lines: ["main"] } },
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
        headers: { cookie: await signedIn(), ...headers },
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
    await fromSite("/api/sessions", { origin: server.url.origin }),
  ];

  expect(statuses).toEqual([403, 403, 200]);
});

test("accepts a runner's calls under Docker's host name with its token alone", async () => {
  const session = await createSession("laptop");
  const host = `host.docker.internal:${server.url.port}`;

  const reached = async (path: string, token?: string): Promise<number> =>
    (
      await fetch(new URL(path, server.url), {
        headers: {
          host,
          "pi-cloud-protocol": "2",
          ...(token !== undefined && { authorization: `Bearer ${token}` }),
        },
      })
    ).status;

  const transcript = `/agent/sessions/${session.id}/transcript`;

  expect(await reached(transcript, await runners.token("laptop"))).toBe(200);
  expect(await reached(transcript)).toBe(401);
  expect(await reached(transcript, "pct_guess")).toBe(401);
  expect(await reached("/api/sessions")).toBe(401);
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

test("shows each session's own Pi TUI under the same terminal id", async () => {
  const first = await createSession("laptop");
  const second = await createSession("laptop");
  await follow(first.id, status("idle"));
  await follow(second.id, status("idle"));
  const firstPi = await openTerminal(first.id, "pi");
  const secondPi = await openTerminal(second.id, "pi");

  const [firstScreen, secondScreen] = await Promise.all([
    firstPi.output("Pi can explain"),
    secondPi.output("Pi can explain"),
  ]);

  firstPi.socket.close();
  secondPi.socket.close();

  expect(firstScreen).toContain("Pi can explain");
  expect(secondScreen).toContain("Pi can explain");
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
      "pi-cloud-protocol": "2",
      authorization: `Bearer ${await runners.token("laptop")}`,
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

async function sessionWhere(
  sessionId: string,
  wanted: (session: Session) => boolean,
): Promise<Session> {
  const events = await follow(sessionId, (seen) =>
    seen.some((e) => e.type === "session" && wanted(e.session)),
  );

  const found = events.findLast(
    (e): e is Extract<SessionEvent, { type: "session" }> =>
      e.type === "session" && wanted(e.session),
  );

  if (!found) {
    throw new Error("session never matched");
  }

  return found.session;
}

async function agentLogged(message: string, generation: number): Promise<void> {
  while (
    !agentLogs.some(
      (line) =>
        line.startsWith(message) &&
        line.includes(`"generation":${String(generation)}`),
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function listed(query = ""): Promise<string[]> {
  return ((await (await api(`/api/sessions${query}`)).json()) as Session[]).map(
    (session) => session.id,
  );
}

const run = promisify(execFile);

async function inRepository(cwd: string, ...args: string[]): Promise<void> {
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
  });
}

// A checkout whose main branch is pushed to a remote, as a real one would be.
async function pushedCheckout(): Promise<string> {
  const checkout = await gitRepository();
  const remote = join(root, "remote.git");
  await run("git", ["init", "--bare", remote]);
  await inRepository(checkout, "remote", "add", "origin", remote);

  await inRepository(
    checkout,
    "push",
    "--quiet",
    "--set-upstream",
    "origin",
    "main",
  );

  return checkout;
}

test("archives a session: unloads it, hides it, refuses messages and replays it", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
  const session = await createSession("laptop");
  await follow(session.id, status("idle"));

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "hi",
  });

  await follow(session.id, (events) => roles(events).includes("assistant"));

  const archived = await api(`/api/sessions/${session.id}/archive`, {});

  expect(archived.status).toBe(200);

  expect(await archived.json()).toMatchObject({
    status: "stopped",
    archivedAt: expect.any(String) as unknown,
    workspaceRemoval: null,
  });

  while (!agentLogs.some((line) => line.startsWith("unloading session"))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const sent = await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "again",
  });

  const replay = await follow(session.id, (events) =>
    roles(events).includes("assistant"),
  );

  expect(sent.status).toBe(409);
  expect(await sent.json()).toEqual({ error: "archived" });
  expect(await listed()).not.toContain(session.id);
  expect(await listed("?archived=true")).toContain(session.id);

  expect(roles(replay).filter((r) => r !== "system")).toEqual([
    "user",
    "assistant",
  ]);
});

test("keeps the end of a turn that was running when its session was archived", async () => {
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
  await api(`/api/sessions/${session.id}/archive`, {});

  const replay = await follow(session.id, (events) =>
    roles(events).includes("assistant"),
  );

  expect(roles(replay).filter((r) => r !== "system")).toEqual([
    "user",
    "assistant",
  ]);
});

test("unarchives a session and reloads it idle with its transcript", async () => {
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
  await api(`/api/sessions/${session.id}/archive`, {});
  await api(`/api/sessions/${session.id}/unarchive`, {});

  await sessionWhere(
    session.id,
    (s) => s.archivedAt === null && s.generation === 2 && s.status === "idle",
  );

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "two",
  });

  const replay = await follow(
    session.id,
    (events) => roles(events).filter((r) => r === "assistant").length === 2,
  );

  expect(
    replay.some((e) => e.type === "entry" && e.entry.includes("remembers one")),
  ).toBe(true);

  expect(await listed()).toContain(session.id);
});

test("removes a clean worktree on archive and brings its pushed work back on unarchive", async () => {
  const checkout = await pushedCheckout();

  const session = await createSession("laptop", {
    kind: "worktree",
    path: checkout,
  });

  const branch = `pi-cloud/${session.id.slice(0, 8)}`;
  const dir = join(root, "laptop", "workspaces", session.id);
  await follow(session.id, status("idle"));
  await writeFile(join(dir, "work.txt"), "work\n");
  await inRepository(dir, "add", ".");
  await inRepository(dir, "commit", "--quiet", "-m", "work");
  await inRepository(dir, "push", "--quiet", "origin", branch);

  await api(`/api/sessions/${session.id}/archive`, {});

  const removed = await sessionWhere(
    session.id,
    (s) => s.workspaceRemoval === "removed",
  );

  expect(removed.workspace).toMatchObject({
    restorePoint: `origin/${branch}`,
  });

  expect(stat(dir)).rejects.toThrow();

  await api(`/api/sessions/${session.id}/unarchive`, {});

  await sessionWhere(
    session.id,
    (s) => s.generation === 2 && s.status === "idle",
  );

  expect(await readFile(join(dir, "work.txt"), "utf8")).toBe("work\n");
});

test("brings pushed work back when unarchived while its worktree is being removed", async () => {
  const checkout = await pushedCheckout();

  const session = await createSession("laptop", {
    kind: "worktree",
    path: checkout,
  });

  const branch = `pi-cloud/${session.id.slice(0, 8)}`;
  const dir = join(root, "laptop", "workspaces", session.id);
  await follow(session.id, status("idle"));
  await writeFile(join(dir, "work.txt"), "work\n");
  await inRepository(dir, "add", ".");
  await inRepository(dir, "commit", "--quiet", "-m", "work");
  await inRepository(dir, "push", "--quiet", "origin", branch);

  await api(`/api/sessions/${session.id}/archive`, {});

  while (!agentLogs.some((line) => line.startsWith("unloading session"))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  await api(`/api/sessions/${session.id}/unarchive`, {});

  const restarted = await sessionWhere(
    session.id,
    (s) => s.generation === 2 && s.status === "idle",
  );

  expect(agentLogs.some((line) => line.startsWith("workspace removed"))).toBe(
    true,
  );

  expect(restarted.workspace).toMatchObject({
    restorePoint: `origin/${branch}`,
  });

  expect(await readFile(join(dir, "work.txt"), "utf8")).toBe("work\n");
});

// Forwards an agent's requests to the server. lose(n) can lose the nth
// workspace removal report on its way to the server, or its reply on the way
// back.
function reportLosingProxy(
  lose: (report: number) => "request" | "reply" | undefined,
): ReturnType<typeof Bun.serve> {
  let reports = 0;

  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url);

      const loss =
        request.method === "POST" && url.pathname.endsWith("/workspace")
          ? lose(++reports)
          : undefined;

      if (loss === "request") {
        return new Response(null, { status: 502 });
      }

      const headers = new Headers(request.headers);
      headers.delete("host");

      const response = await fetch(
        new URL(url.pathname + url.search, server.url),
        {
          method: request.method,
          headers,
          body: request.method === "GET" ? null : await request.arrayBuffer(),
          signal: request.signal,
        },
      );

      return loss === "reply" ? new Response(null, { status: 502 }) : response;
    },
  });
}

async function archivedWithPushedWork(): Promise<{
  readonly session: Session;
  readonly dir: string;
}> {
  const checkout = await pushedCheckout();

  const session = await createSession("laptop", {
    kind: "worktree",
    path: checkout,
  });

  const branch = `pi-cloud/${session.id.slice(0, 8)}`;
  const dir = join(root, "laptop", "workspaces", session.id);
  await follow(session.id, status("idle"));
  await writeFile(join(dir, "work.txt"), "work\n");
  await inRepository(dir, "add", ".");
  await inRepository(dir, "commit", "--quiet", "-m", "work");
  await inRepository(dir, "push", "--quiet", "origin", branch);
  await api(`/api/sessions/${session.id}/archive`, {});

  return { session, dir };
}

test("sends a lost removal report again instead of removing the worktree twice", async () => {
  const proxy = reportLosingProxy((report) =>
    report === 1 ? "request" : undefined,
  );

  await laptop();
  const agent = await startAgent("laptop", [], proxy.url);
  try {
    const { session, dir } = await archivedWithPushedWork();
    await sessionWhere(session.id, (s) => s.workspaceRemoval === "removed");
    await api(`/api/sessions/${session.id}/unarchive`, {});

    await sessionWhere(
      session.id,
      (s) => s.generation === 2 && s.status === "idle",
    );

    expect(await readFile(join(dir, "work.txt"), "utf8")).toBe("work\n");
  } finally {
    await agent();
    await proxy.stop(true);
  }
});

test("brings pushed work back when unarchived before a lost removal report gets through", async () => {
  const proxy = reportLosingProxy(() => "request");
  await laptop();
  const agent = await startAgent("laptop", [], proxy.url);
  try {
    const { session, dir } = await archivedWithPushedWork();

    while (
      !agentLogs.some((line) =>
        line.startsWith("workspace removal not reported"),
      )
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await api(`/api/sessions/${session.id}/unarchive`, {});

    await sessionWhere(
      session.id,
      (s) => s.generation === 2 && s.status === "idle",
    );

    expect(await readFile(join(dir, "work.txt"), "utf8")).toBe("work\n");
  } finally {
    await agent();
    await proxy.stop(true);
  }
});

test("forces a removal whose kept report reached the server but not its reply", async () => {
  const proxy = reportLosingProxy((report) =>
    report === 1 ? "reply" : undefined,
  );

  await laptop();
  const agent = await startAgent("laptop", [], proxy.url);
  try {
    const checkout = await pushedCheckout();

    const session = await createSession("laptop", {
      kind: "worktree",
      path: checkout,
    });

    const dir = join(root, "laptop", "workspaces", session.id);
    await follow(session.id, status("idle"));
    await writeFile(join(dir, "work.txt"), "work\n");
    await inRepository(dir, "add", ".");
    await inRepository(dir, "commit", "--quiet", "-m", "work");
    await api(`/api/sessions/${session.id}/archive`, {});
    await sessionWhere(session.id, (s) => s.workspaceRemoval === "kept");
    await api(`/api/sessions/${session.id}/remove-workspace`, {});
    await sessionWhere(session.id, (s) => s.workspaceRemoval === "removed");
    const leftover = await stat(dir).catch(() => undefined);

    expect(leftover).toBeUndefined();
  } finally {
    await agent();
    await proxy.stop(true);
  }
});

test("leaves no worktree behind when archived again while its first removal runs", async () => {
  const checkout = await pushedCheckout();

  const session = await createSession("laptop", {
    kind: "worktree",
    path: checkout,
  });

  const branch = `pi-cloud/${session.id.slice(0, 8)}`;
  const dir = join(root, "laptop", "workspaces", session.id);
  await follow(session.id, status("idle"));

  let answer = (): void => undefined;

  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });

  faux.setResponses([
    async () => {
      await answered;

      return fauxAssistantMessage([fauxText("slow to stop")]);
    },
  ]);

  const watching = await watch(session.id);

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "hi",
  });

  await watching(status("running"));
  await api(`/api/sessions/${session.id}/archive`, {});
  await agentLogged("unloading session", 1);
  await api(`/api/sessions/${session.id}/unarchive`, {});
  await agentLogged("starting session", 2);
  await api(`/api/sessions/${session.id}/archive`, {});
  await agentLogged("unloading session", 2);
  answer();
  await sessionWhere(session.id, (s) => s.workspaceRemoval === "removed");
  await laptop();

  const branches = await run("git", ["branch", "--list", branch], {
    cwd: checkout,
  });

  const worktrees = await run("git", ["worktree", "list"], { cwd: checkout });
  const leftover = await stat(dir).catch(() => undefined);

  expect(leftover).toBeUndefined();
  expect(branches.stdout).toBe("");
  expect(worktrees.stdout).not.toContain(dir);
});

test("stores the restore point of a removal reported after unarchive", async () => {
  const session = await createSession("vm", {
    kind: "worktree",
    path: root,
  });

  await api(`/api/sessions/${session.id}/archive`, {});

  const work = (await (
    await asAgent("vm", "/agent/work", {
      running: [],
      folders: [],
      models: [],
    })
  ).json()) as Work;

  expect(work).toMatchObject({ remove: [{ sessionId: session.id }] });

  await api(`/api/sessions/${session.id}/unarchive`, {});

  const restore = {
    ...session.workspace,
    restorePoint: "origin/pi-cloud/restored",
  };

  const reported = await asAgent(
    "vm",
    `/agent/sessions/${session.id}/workspace`,
    { generation: work.remove[0]?.generation, outcome: "removed", restore },
  );

  const stored = (await (
    await api(`/api/sessions/${session.id}`)
  ).json()) as Session;

  expect(reported.status).toBe(204);
  expect(stored.workspace).toEqual(restore);
  expect(stored.archivedAt).toBeNull();
  expect(stored.workspaceRemoval).toBeNull();
});

test("settles a removal only with the report for the archive it was handed out for", async () => {
  const session = await createSession("vm", {
    kind: "worktree",
    path: root,
  });

  const poll = async (generation?: number): Promise<Work> =>
    (await (
      await asAgent("vm", "/agent/work", {
        running:
          generation === undefined
            ? []
            : [{ sessionId: session.id, generation }],
        folders: [],
        models: [],
      })
    ).json()) as Work;

  const report = async (
    removal: Work["remove"][number] | undefined,
  ): Promise<Session> => {
    await asAgent("vm", `/agent/sessions/${session.id}/workspace`, {
      generation: removal?.generation,
      outcome: "removed",
      restore: {
        ...removal?.workspace,
        startPoint: "origin/pi-cloud/restored",
      },
    });

    return (await (await api(`/api/sessions/${session.id}`)).json()) as Session;
  };

  await poll();
  await api(`/api/sessions/${session.id}/archive`, {});
  const [first] = (await poll(1)).remove;
  await api(`/api/sessions/${session.id}/unarchive`, {});
  await poll();
  await api(`/api/sessions/${session.id}/archive`, {});
  const overtaken = await report(first);
  const [second] = (await poll(2)).remove;
  const settled = await report(second);

  expect(overtaken).toMatchObject({
    workspace: { startPoint: "origin/pi-cloud/restored" },
    workspaceRemoval: "pending",
  });

  expect(second).toMatchObject({ sessionId: session.id, generation: 2 });
  expect(settled.workspaceRemoval).toBe("removed");
});

test("keeps a session's workspace when a removal report's restore has no kind", async () => {
  const session = await createSession("vm", {
    kind: "worktree",
    path: root,
  });

  const reported = await asAgent(
    "vm",
    `/agent/sessions/${session.id}/workspace`,
    {
      generation: 0,
      outcome: "removed",
      restore: { path: root, branch: "pi-cloud/other" },
    },
  );

  const stored = (await (
    await api(`/api/sessions/${session.id}`)
  ).json()) as Session;

  expect(reported.status).toBe(400);
  expect(stored.workspace).toEqual(session.workspace);
});

test("checks several repositories out in one workspace and shows each one's changes", async () => {
  const checkout = await pushedCheckout();
  const remote = join(root, "remote.git");
  const tools = join(root, "tools");
  await run("git", ["init", "--initial-branch=main", tools]);
  await writeFile(join(tools, "README.md"), "tools\n");
  await inRepository(tools, "add", ".");
  await inRepository(tools, "commit", "--quiet", "-m", "first");

  const session = await createSession("laptop", {
    kind: "repositories",
    repositories: [{ repository: remote }, { repository: tools }],
  });

  const dir = join(root, "laptop", "workspaces", session.id);
  await follow(session.id, status("idle"));

  expect(
    (await run("git", ["worktree", "list"], { cwd: checkout })).stdout,
  ).toContain(join(dir, "remote"));

  await writeFile(join(dir, "tools", "draft.txt"), "draft\n");
  faux.setResponses([fauxAssistantMessage([fauxText("noted")])]);

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "look around",
  });

  const events = await follow(session.id, (seen) =>
    seen.some(
      (e) =>
        e.type === "live" &&
        e.event.type === "plugin" &&
        JSON.stringify(e.event.data).includes("draft.txt"),
    ),
  );

  const changes = events.flatMap((e) =>
    e.type === "live" && e.event.type === "plugin" ? [e.event.data] : [],
  );

  expect(changes.at(-1)).toMatchObject([
    { name: "remote", files: [] },
    { name: "tools", files: [{ status: "A", path: "draft.txt" }] },
  ]);

  await api(`/api/sessions/${session.id}/archive`, {});

  const kept = await sessionWhere(
    session.id,
    (s) => s.workspaceRemoval === "kept",
  );

  expect(kept.workspaceRemoval).toBe("kept");
  expect((await stat(join(dir, "tools", "draft.txt"))).isFile()).toBe(true);
});

test("rejects repositories that would share a folder", async () => {
  const response = await api("/api/sessions", {
    environment: await environmentOf("laptop"),
    workspace: {
      kind: "repositories",
      repositories: [
        { repository: "https://example.com/a/tool.git" },
        { repository: "git@example.com:b/tool" },
      ],
    },
  });

  expect(response.status).toBe(400);

  expect(await response.json()).toEqual({
    error: "repositories need different names",
  });
});

test("rejects a repository whose URL leaves no name for its folder", async () => {
  for (const repository of [
    "https://example.com/org/..",
    "https://example.com/org/.",
    "/home/me/app/.git",
  ]) {
    const response = await api("/api/sessions", {
      environment: await environmentOf("laptop"),
      workspace: { kind: "repositories", repositories: [{ repository }] },
    });

    expect(response.status).toBe(400);
  }
});

test("keeps a worktree with unpushed work on archive until the user forces removal", async () => {
  const checkout = await pushedCheckout();

  const session = await createSession("laptop", {
    kind: "worktree",
    path: checkout,
  });

  const dir = join(root, "laptop", "workspaces", session.id);
  await follow(session.id, status("idle"));
  await writeFile(join(dir, "work.txt"), "work\n");
  await inRepository(dir, "add", ".");
  await inRepository(dir, "commit", "--quiet", "-m", "work");

  const early = await api(`/api/sessions/${session.id}/remove-workspace`, {});
  await api(`/api/sessions/${session.id}/archive`, {});
  await sessionWhere(session.id, (s) => s.workspaceRemoval === "kept");

  const kept = (await (
    await api(`/api/sessions/${session.id}`)
  ).json()) as Session;

  expect(early.status).toBe(409);
  expect(kept.workspaceKeptReason).toBe("unpushed commits");
  expect(await readFile(join(dir, "work.txt"), "utf8")).toBe("work\n");

  const forced = await api(`/api/sessions/${session.id}/remove-workspace`, {});
  await sessionWhere(session.id, (s) => s.workspaceRemoval === "removed");

  const removed = (await (
    await api(`/api/sessions/${session.id}`)
  ).json()) as Session;

  expect(forced.status).toBe(200);
  expect(removed.workspaceKeptReason).toBeNull();
  expect(stat(dir)).rejects.toThrow();
});

test("keeps a workspace whose removal fails until the user forces removal", async () => {
  const checkout = await pushedCheckout();

  const session = await createSession("laptop", {
    kind: "worktree",
    path: checkout,
  });

  const dir = join(root, "laptop", "workspaces", session.id);
  await follow(session.id, status("idle"));
  await rm(join(checkout, ".git"), { recursive: true, force: true });

  await api(`/api/sessions/${session.id}/archive`, {});
  await sessionWhere(session.id, (s) => s.workspaceRemoval === "kept");

  expect((await stat(dir)).isDirectory()).toBe(true);

  const forced = await api(`/api/sessions/${session.id}/remove-workspace`, {});
  await sessionWhere(session.id, (s) => s.workspaceRemoval === "removed");

  expect(forced.status).toBe(200);
  expect(stat(dir)).rejects.toThrow();
});

test("removes an archived session's workspace when its provider comes back", async () => {
  const checkout = await pushedCheckout();

  const session = await createSession("laptop", {
    kind: "worktree",
    path: checkout,
  });

  const dir = join(root, "laptop", "workspaces", session.id);
  await follow(session.id, status("idle"));

  await laptop();
  await api(`/api/sessions/${session.id}/archive`, {});
  const pending = await api(`/api/sessions/${session.id}`);

  expect(await pending.json()).toMatchObject({ workspaceRemoval: "pending" });

  await startAgent("laptop");
  await sessionWhere(session.id, (s) => s.workspaceRemoval === "removed");

  expect(stat(dir)).rejects.toThrow();
});

test("creates a session in the first Environment unless the request names one", async () => {
  const laptopEnvironment = await environmentOf("laptop");
  await environmentOf("vm");

  const first = (await (
    await api("/api/sessions", { workspace: { kind: "folder", path: root } })
  ).json()) as Session;

  const unknown = await api("/api/sessions", {
    environment: "nowhere",
    workspace: { kind: "folder", path: root },
  });

  expect(first).toMatchObject({
    environmentId: laptopEnvironment,
    provider: "laptop",
    ownerId: "local",
  });

  expect(unknown.status).toBe(400);
  expect(await unknown.json()).toEqual({ error: "unknown_environment" });
});

test("sends browser commands to the session as the signed-in user, whatever the browser claims", async () => {
  const { user } = (await (await api("/api/auth")).json()) as {
    user: { id: string };
  };

  const session = await createSession("laptop");
  await follow(session.id, status("idle"));

  await api(`/api/sessions/${session.id}/commands`, {
    type: "abort",
    actor: "plugin:impostor",
  });

  while (!agentLogs.some((line) => line.startsWith("command received"))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  expect(
    agentLogs.filter((line) => line.startsWith("command received")),
  ).toEqual([
    `command received ${JSON.stringify({ sessionId: session.id, command: "abort", actor: `user:${user.id}` })}`,
  ]);
});

// An OpenAI-compatible endpoint, since Pi's in-memory faux provider can't
// reach a Session in another process. With a command, the first request
// answers with a bash call running it.
function fakeModelServer(
  reply: string,
  command?: string,
): ReturnType<typeof Bun.serve> {
  const chunk = (choice: object): string =>
    `data: ${JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake-model",
      choices: [{ index: 0, ...choice }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`;

  const toolCall = [
    chunk({
      delta: {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command }) },
          },
        ],
      },
    }),
    chunk({ delta: {}, finish_reason: "tool_calls" }),
  ];

  const text = [
    chunk({ delta: { role: "assistant", content: reply } }),
    chunk({ delta: {}, finish_reason: "stop" }),
  ];

  let requests = 0;

  return Bun.serve({
    port: 0,
    fetch: () => {
      requests += 1;
      const chunks = command !== undefined && requests === 1 ? toolCall : text;

      return new Response([...chunks, "data: [DONE]\n\n"].join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
}

async function startProcessAgent(
  model: ReturnType<typeof Bun.serve>,
  extensionPaths: readonly string[] = [],
): Promise<void> {
  const dataDir = join(root, "process");
  await mkdir(dataDir, { recursive: true });

  await writeFile(
    join(dataDir, "models.json"),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: new URL("/v1", model.url).href,
          api: "openai-completions",
          apiKey: "fake",
          models: [{ id: "fake-model" }],
        },
      },
    }),
  );

  const controller = new AbortController();

  const done = runAgent({
    server: server.url.href,
    provider: "process",
    credential: { key: await runners.key("process") },
    dataDir,
    extensionPaths,
    folders: [root],
    log: (message, fields) => {
      agentLogs.push(`${message} ${JSON.stringify(fields)}`);
    },
    signal: controller.signal,
  });

  agents.push(async () => {
    controller.abort();
    await done;
  });
}

function sessionPids(sessionId: string): number[] {
  return agentLogs.flatMap((line) => {
    if (!line.startsWith("session process started")) {
      return [];
    }

    const fields = JSON.parse(line.slice(line.indexOf("{"))) as {
      sessionId: string;
      pid: number;
    };

    return fields.sessionId === sessionId ? [fields.pid] : [];
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

test("runs each session in its own process and reloads it when the process dies", async () => {
  const model = fakeModelServer("hello from a session process");
  await startProcessAgent(model);

  try {
    const session = (await (
      await api("/api/sessions", {
        environment: await environmentOf("process"),
        workspace: { kind: "folder", path: root },
        model: { provider: "fake", id: "fake-model" },
      })
    ).json()) as Session;

    await follow(session.id, status("idle"));

    await api(`/api/sessions/${session.id}/commands`, {
      type: "message",
      text: "hi",
    });

    const reply = await follow(session.id, (events) =>
      events.some(
        (e) =>
          e.type === "entry" &&
          e.entry.includes("hello from a session process"),
      ),
    );

    const [first] = sessionPids(session.id);

    expect(roles(reply)).toContain("assistant");
    expect(first !== undefined && alive(first)).toBe(true);

    process.kill(first ?? 0, "SIGKILL");

    await sessionWhere(
      session.id,
      (s) => s.generation === 2 && s.status === "idle",
    );

    const [, second] = sessionPids(session.id);

    expect(second).not.toBe(first);
    expect(second !== undefined && alive(second)).toBe(true);

    const terminal = await openTerminal(session.id);
    terminal.socket.send(encoder.encode("echo dir=$(pwd) sum=$((40+2))\n"));

    expect(await terminal.output("sum=42")).toContain(`dir=${root}`);

    await api(`/api/sessions/${session.id}/archive`, {});
    while (second !== undefined && alive(second)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await model.stop(true);
  }
}, 30_000);

test("records a tool cut off by its host going down as interrupted, not by its exit code", async () => {
  const pidFile = join(root, "tool.pid");
  const model = fakeModelServer("done", `echo $$ > ${pidFile}; exec sleep 30`);
  await startProcessAgent(model);

  try {
    const session = (await (
      await api("/api/sessions", {
        environment: await environmentOf("process"),
        workspace: { kind: "folder", path: root },
        model: { provider: "fake", id: "fake-model" },
      })
    ).json()) as Session;

    await follow(session.id, status("idle"));

    await api(`/api/sessions/${session.id}/commands`, {
      type: "message",
      text: "run something slow",
    });

    let toolPid = Number.NaN;
    while (Number.isNaN(toolPid)) {
      toolPid = Number.parseInt(
        await readFile(pidFile, "utf8").catch(() => ""),
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // systemd stops a service by sending SIGTERM to every process in it.
    const [sessionPid] = sessionPids(session.id);
    process.kill(sessionPid ?? 0, "SIGTERM");
    process.kill(toolPid, "SIGTERM");

    const events = await follow(session.id, (seen) =>
      seen.some(
        (e) =>
          e.type === "entry" &&
          (e.entry.includes("interrupted by a restart") ||
            e.entry.includes("exited with code 143")),
      ),
    );

    const results = events.filter(
      (e) => e.type === "entry" && e.entry.includes('"toolResult"'),
    );

    expect(results).toHaveLength(1);
    expect(JSON.stringify(results)).toContain("interrupted by a restart");
  } finally {
    await model.stop(true);
  }
}, 30_000);

test("sends a session process its first message", async () => {
  const model = fakeModelServer("first reply");
  await startProcessAgent(model);

  try {
    const session = (await (
      await api("/api/sessions", {
        environment: await environmentOf("process"),
        workspace: { kind: "folder", path: root },
        model: { provider: "fake", id: "fake-model" },
        firstMessage: "start here",
      })
    ).json()) as Session;

    const events = await follow(session.id, (seen) =>
      seen.some((e) => e.type === "entry" && e.entry.includes("first reply")),
    );

    expect(roles(events)).toEqual(["system", "user", "assistant"]);
  } finally {
    await model.stop(true);
  }
}, 30_000);

test("marks a session failed when its process cannot start it", async () => {
  const model = fakeModelServer("unused");
  await startProcessAgent(model);

  try {
    const session = (await (
      await api("/api/sessions", {
        environment: await environmentOf("process"),
        workspace: { kind: "folder", path: root },
        model: { provider: "nowhere", id: "none" },
      })
    ).json()) as Session;

    const failed = await sessionWhere(session.id, (s) => s.status === "failed");

    expect(failed.error).toContain("model not available: nowhere/none");
  } finally {
    await model.stop(true);
  }
}, 30_000);

test("keeps a session process working when its extensions print JSON", async () => {
  const model = fakeModelServer("reply despite the noise");
  const extension = join(root, "noisy.ts");

  await writeFile(
    extension,
    `export default (pi) => {
  pi.on("session_start", () => {
    console.log(JSON.stringify({ error: "stray" }));
    console.log(JSON.stringify({ terminal: null }));
    console.log(JSON.stringify({ type: "terminal", command: null }));
  });
};
`,
  );

  await startProcessAgent(model, [extension]);

  try {
    const session = (await (
      await api("/api/sessions", {
        environment: await environmentOf("process"),
        workspace: { kind: "folder", path: root },
        model: { provider: "fake", id: "fake-model" },
      })
    ).json()) as Session;

    await follow(session.id, status("idle"));

    await api(`/api/sessions/${session.id}/commands`, {
      type: "message",
      text: "hi",
    });

    const reply = await follow(session.id, (events) =>
      events.some(
        (e) =>
          e.type === "entry" && e.entry.includes("reply despite the noise"),
      ),
    );

    expect(roles(reply)).toContain("assistant");

    expect(
      agentLogs.some(
        (line) =>
          line.startsWith("session process output") && line.includes("stray"),
      ),
    ).toBe(true);

    const terminal = await openTerminal(session.id);
    terminal.socket.send(encoder.encode("echo sum=$((40+2))\n"));

    expect(await terminal.output("sum=42")).toContain("sum=42");
  } finally {
    await model.stop(true);
  }
}, 30_000);
