import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
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
} from "@pipoca/protocol";
import { runAgent } from "./agent";
import { serve } from "./serve";
import { runnerCredentials } from "./testdata/runners";
import { firstUser } from "./testdata/sign-in";
import { readSse } from "./sse";

let root: string;
let server: ReturnType<typeof serve>;
let signedIn: () => Promise<string>;
let runners: ReturnType<typeof runnerCredentials>;
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

  const logs: string[] = [];

  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 100, offlineAfterMs: 200 },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
  runners = runnerCredentials(server, signedIn);

  const controller = new AbortController();

  const done = runAgent({
    server: server.url.href,
    provider: "laptop",
    credential: { key: await runners.key("laptop") },
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
    headers: {
      cookie: await signedIn(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
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
    { signal: controller.signal, headers: { cookie: await signedIn() } },
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

test("a machine deletes a deleted Profile's folder once its Sessions stop", async () => {
  const session = await sessionWith({ agentsMd: "Be brief." });
  await until(session.id, ({ status }) => status === "idle");

  const dir = join(root, "laptop", "profiles", session.profileId);

  const exists = async (): Promise<boolean> =>
    stat(dir).then(
      () => true,
      () => false,
    );

  expect(await exists()).toBe(true);

  await api(`/api/sessions/${session.id}/archive`, {});

  await fetch(new URL(`/api/profiles/${session.profileId}`, server.url), {
    method: "DELETE",
    headers: { cookie: await signedIn() },
  });

  const deadline = Date.now() + 5000;
  while ((await exists()) && Date.now() < deadline) {
    await sleep(50);
  }

  expect(await exists()).toBe(false);
});

test("leaves Profile folders another server wrote in a shared data directory", async () => {
  const dataDir = join(root, "shared");
  const folder = join(dataDir, "profiles", "theirs");
  await mkdir(folder, { recursive: true });
  await writeFile(join(dataDir, "profiles", ".server"), "http://elsewhere");

  const controller = new AbortController();
  let polls = 0;

  const done = runAgent({
    server: server.url.href,
    provider: "shared",
    credential: { key: await runners.key("shared") },
    dataDir,
    extensionPaths: [],
    folders: [],
    log: (message) => {
      if (message === "provider polling for work") {
        polls++;
      }
    },
    signal: controller.signal,
  });

  while (polls === 0) {
    await sleep(20);
  }

  await sleep(500);
  controller.abort();
  await done;

  expect(await stat(folder).then(() => true)).toBe(true);
});

test("moves a machine's login files into its logins folder", async () => {
  const dataDir = join(root, "upgraded");
  await mkdir(dataDir, { recursive: true });

  for (const name of ["auth.json", "models-store.json"]) {
    await writeFile(join(dataDir, name), "{}");
  }

  const controller = new AbortController();
  const polling = Promise.withResolvers<undefined>();

  const done = runAgent({
    server: server.url.href,
    provider: "upgraded",
    credential: { key: await runners.key("upgraded") },
    dataDir,
    extensionPaths: [],
    folders: [],
    log: (message) => {
      if (message === "provider polling for work") {
        polling.resolve(undefined);
      }
    },
    signal: controller.signal,
  });

  await polling.promise;
  controller.abort();
  await done;

  const exists = async (path: string): Promise<boolean> =>
    stat(path).then(
      () => true,
      () => false,
    );

  expect(await exists(join(dataDir, "logins", "auth.json"))).toBe(true);
  expect(await exists(join(dataDir, "logins", "models-store.json"))).toBe(true);
  expect(await exists(join(dataDir, "models-store.json"))).toBe(false);
});
