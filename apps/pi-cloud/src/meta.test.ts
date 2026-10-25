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
  Assignment,
  Prompt,
  Session,
  SessionEvent,
  SlashCommand,
} from "@pi-cloud/protocol";
import { serve } from "./serve";
import { runnerCredentials } from "./testdata/runners";
import { firstUser } from "./testdata/sign-in";
import { readSse } from "./sse";

let root: string;
let faux: ReturnType<typeof fauxProvider>;
let server: ReturnType<typeof serve>;
let signedIn: () => Promise<string>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-cloud-meta-")));
  faux = fauxProvider();

  const runtime = await ModelRuntime.create({
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
    disabledPlugins: ["subagents"],
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
});

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

test("starts a meta-session on the meta Profile and keeps it out of the Session list", async () => {
  faux.setResponses([
    (context) =>
      fauxAssistantMessage([
        fauxText(
          JSON.stringify(context.messages).includes("Pi Cloud's assistant")
            ? "the assistant answers"
            : "someone else answers",
        ),
      ]),
  ]);

  const session = await startMeta("What can you do?");
  await follow(session.id, entriesInclude("the assistant answers"));

  const listed = await json<Session[]>(api("/api/sessions"));
  const owned = await json<Session[]>(api("/api/plugins/meta/sessions"));

  expect(listed.map(({ id }) => id)).not.toContain(session.id);
  expect(owned.map(({ id }) => id)).toEqual([session.id]);
});

test("refuses a meta-session without a first message", async () => {
  await environmentReady();
  const response = await api("/api/plugins/meta/sessions", { text: " " });

  expect(response.status).toBe(400);
});

test("asks before a risky call, runs it only when allowed, and never asks for reads", async () => {
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("read", { path: "missing.txt" }),
        fauxToolCall("bash", { command: "echo first" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo second" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("all done")]),
  ]);

  const session = await startMeta("Run something");

  const asked: Prompt[] = [];

  const answer = async (allowed: boolean): Promise<void> => {
    const events = await follow(session.id, (all) =>
      prompts(all).some(({ id }) => !asked.some((seen) => seen.id === id)),
    );

    const prompt = prompts(events).find(
      ({ id }) => !asked.some((seen) => seen.id === id),
    );

    asked.push(...(prompt ? [prompt] : []));

    await api(`/api/sessions/${session.id}/commands`, {
      type: "answer",
      id: prompt?.id,
      value: allowed,
    });
  };

  await answer(false);
  await answer(true);

  const events = await follow(session.id, entriesInclude("all done"));

  const transcript = events
    .flatMap((e) => (e.type === "entry" ? [e.entry] : []))
    .join("\n");

  expect(asked.map(({ title }) => title)).toEqual([
    "Allow bash?",
    "Allow bash?",
  ]);

  expect(transcript).toContain("The user didn't allow bash.");
  expect(transcript).toContain("second");
  expect(transcript).not.toContain("first\\n");
});

test("loads the meta-session's confirm only in meta-sessions", async () => {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo ran" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("all done")]),
  ]);

  await environmentReady();

  const session = await json<Session>(
    api("/api/sessions", {
      workspace: { kind: "folder", path: root },
      firstMessage: "Run something",
    }),
  );

  const events = await follow(session.id, entriesInclude("all done"));

  expect(prompts(events)).toEqual([]);

  expect(
    events.some((e) => e.type === "entry" && e.entry.includes("ran\\n")),
  ).toBe(true);
});

const commandsOf = (
  events: readonly SessionEvent[],
): readonly SlashCommand[] | undefined =>
  events.flatMap((e) =>
    e.type === "live" && e.event.type === "commands" ? [e.event.commands] : [],
  )[0];

test("loads only the Session parts the meta plugin allows in a meta-session", async () => {
  faux.setResponses([
    fauxAssistantMessage([fauxText("hi")]),
    fauxAssistantMessage([fauxText("hi")]),
  ]);

  const metaSession = await startMeta("Hello");

  const ordinary = await json<Session>(
    api("/api/sessions", { workspace: { kind: "folder", path: root } }),
  );

  const names = async (id: string): Promise<string[]> =>
    (
      commandsOf(await follow(id, (all) => commandsOf(all) !== undefined)) ?? []
    ).map(({ name }) => name);

  expect(await names(ordinary.id)).toContain("pr");
  expect(await names(metaSession.id)).not.toContain("pr");
});

test("shows the whole input of a risky call it asks about", async () => {
  const command = `echo ${"x".repeat(900)}; echo the end`;

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("all done")]),
  ]);

  const session = await startMeta("Run something");

  const [asked] = prompts(
    await follow(session.id, (all) => prompts(all).length > 0),
  );

  await api(`/api/sessions/${session.id}/commands`, {
    type: "answer",
    id: asked?.id,
    value: false,
  });

  expect(asked?.kind === "confirm" && asked.message).toContain("the end");
});

test("stops a turn that waits on a confirm", async () => {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], {
      stopReason: "toolUse",
    }),
  ]);

  const session = await startMeta("Run something");
  await follow(session.id, (all) => prompts(all).length > 0);

  await api(`/api/sessions/${session.id}/commands`, { type: "abort" });

  await follow(session.id, (all) =>
    all.some((e) => e.type === "session" && e.session.status === "idle"),
  );
});

test("hands a runner only the allowed Session parts and requires the meta one", async () => {
  const logs: string[] = [];

  const bare = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 0 },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  try {
    const cookie = firstUser(bare, logs);
    const runners = runnerCredentials(bare, cookie);
    const token = await runners.token("vm");

    const post = async (path: string, body: unknown): Promise<Session> =>
      json<Session>(
        fetch(new URL(path, bare.url), {
          method: "POST",
          headers: {
            cookie: await cookie(),
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );

    const metaSession = await post("/api/plugins/meta/sessions", {
      text: "Hello",
    });

    const ordinary = await post("/api/sessions", {
      workspace: { kind: "folder", path: "/work" },
    });

    const work = await json<{ start: Assignment[] }>(
      fetch(new URL("/agent/work", bare.url), {
        method: "POST",
        headers: {
          "pi-cloud-protocol": "3",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ running: [], folders: ["/work"], models: [] }),
      }),
    );

    const of = (id: string): Assignment | undefined =>
      work.start.find(({ sessionId }) => sessionId === id);

    expect(of(metaSession.id)?.plugins).toEqual(["ask", "models", "meta"]);
    expect(of(metaSession.id)?.requiredPlugins).toEqual(["meta"]);
    expect(of(ordinary.id)?.plugins).not.toContain("meta");
    expect(of(ordinary.id)?.requiredPlugins).toEqual([]);
  } finally {
    await bare.stop();
  }
});
