import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Session, SessionEvent } from "@pi-cloud/protocol";
import { runAgent } from "./agent";
import { serve } from "./serve";
import { readSse } from "./sse";

let root: string;
let server: ReturnType<typeof serve>;
let stopAgent: AbortController;
let agentDone: Promise<void>;
let faux: ReturnType<typeof fauxProvider>;

const quiet = (): void => undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-cloud-"));
  server = serve({ port: 0, database: ":memory:", log: quiet });
  faux = fauxProvider();
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  stopAgent = new AbortController();
  agentDone = runAgent({
    server: server.url.href,
    provider: "laptop",
    dataDir: join(root, "agent"),
    agentDir: join(root, "pi"),
    extensionPaths: [],
    models: { runtime, model: faux.getModel() },
    log: quiet,
    signal: stopAgent.signal,
  });
});

afterEach(async () => {
  stopAgent.abort();
  await agentDone;
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

async function createSession(provider: string): Promise<Session> {
  return (await (
    await api("/api/sessions", { provider, cwd: root })
  ).json()) as Session;
}

async function watch(
  sessionId: string,
): Promise<
  (
    until: (events: readonly SessionEvent[]) => boolean,
  ) => Promise<SessionEvent[]>
> {
  const controller = new AbortController();
  const response = await fetch(
    new URL(`/api/sessions/${sessionId}/events`, server.url),
    { signal: controller.signal },
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
  const work = (await (await asAgent("vm", "/agent/work")).json()) as {
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
  await asAgent("vm", "/agent/work");

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

  const version = await asAgent("vm", "/agent/work", undefined, "99");
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

  stopAgent.abort();
  await agentDone;
  const sent = await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "hi",
  });

  expect(sent.status).toBe(409);
});
