import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  Environment,
  Profile,
  ProfileContent,
  Session,
  SessionEvent,
} from "@pi-cloud/protocol";
import { runAgent } from "./agent";
import { serve } from "./serve";
import { readSse } from "./sse";

let root: string;
let server: ReturnType<typeof serve>;
let faux: ReturnType<typeof fauxProvider>;
let stopAgent: () => Promise<void>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "profile-sessions-")));
  faux = fauxProvider();

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 100, offlineAfterMs: 200 },
    log: () => undefined,
  });

  const controller = new AbortController();

  const done = runAgent({
    server: server.url.href,
    provider: "laptop",
    dataDir: join(root, "laptop"),
    extensionPaths: [],
    folders: [root],
    models: { runtime, model: faux.getModel() },
    log: () => undefined,
    signal: controller.signal,
  });

  stopAgent = async () => {
    controller.abort();
    await done;
  };
});

afterEach(async () => {
  await stopAgent();
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    ...(body !== undefined && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });

  return (await response.json()) as T;
}

async function sessionWith(content: Partial<ProfileContent>): Promise<Session> {
  const profile = await api<Profile>("/api/profiles", {
    name: "Work",
    ...content,
  });

  let environment: Environment | undefined;
  while (environment === undefined) {
    environment = (await api<Environment[]>("/api/environments")).find(
      (each) => each.online,
    );
  }

  return api<Session>("/api/sessions", {
    environment: environment.id,
    profile: profile.id,
    workspace: { kind: "folder", path: root },
  });
}

async function until(
  sessionId: string,
  done: (session: Session) => boolean,
): Promise<Session> {
  const controller = new AbortController();

  const response = await fetch(
    new URL(`/api/sessions/${sessionId}/events`, server.url),
    { signal: controller.signal },
  );

  for await (const event of readSse(response)) {
    const sessionEvent = event as SessionEvent;
    if (sessionEvent.type === "session" && done(sessionEvent.session)) {
      controller.abort();

      return sessionEvent.session;
    }
  }

  throw new Error("events ended");
}

async function firstRequest(session: Session): Promise<string> {
  const seen = Promise.withResolvers<string>();

  faux.setResponses([
    (context) => {
      seen.resolve(JSON.stringify(context));

      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);

  await until(session.id, ({ status }) => status === "idle");

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "hello",
  });

  return seen.promise;
}

test("a Session's Pi reads the instructions its Profile holds", async () => {
  const session = await sessionWith({
    agentsMd: "Answer like a pirate.",
    appendSystemMd: "Never use tables.",
  });

  const request = await firstRequest(session);

  expect(request).toContain("Answer like a pirate.");
  expect(request).toContain("Never use tables.");
});

test("a Session loads the packages its Profile lists", async () => {
  const kit = join(root, "kit");
  await mkdir(join(kit, "extensions"), { recursive: true });

  await writeFile(
    join(kit, "package.json"),
    JSON.stringify({ name: "kit", pi: { extensions: ["./extensions"] } }),
  );

  await writeFile(
    join(kit, "extensions", "kit.ts"),
    `export default (pi) => pi.registerTool({
      name: "kit_tool",
      label: "Kit",
      description: "A tool from the Profile's package",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });`,
  );

  const request = await firstRequest(await sessionWith({ packages: [kit] }));

  expect(request).toContain("kit_tool");
});

test("a package that can't be installed stops the Session, naming it", async () => {
  const missing = join(root, "no-such-package");
  const session = await sessionWith({ packages: [missing] });

  const failed = await until(session.id, ({ status }) => status === "failed");

  expect(failed.error).toContain(`package ${missing} failed to install`);
});
