import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { EnvironmentModels } from "@pipoca/models/model";
import type { Environment, Session } from "@pipoca/protocol";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";

let root: string;
let primary: ReturnType<typeof fauxProvider>;
let fallback: ReturnType<typeof fauxProvider>;
let server: ReturnType<typeof serve> | undefined;
let signedIn: () => Promise<string>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-models-")));
  primary = fauxProvider({ provider: "primary" });
  fallback = fauxProvider({ provider: "fallback" });

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(primary.provider);
  runtime.registerNativeProvider(fallback.provider);

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
      models: { runtime, model: primary.getModel() },
    },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

async function api(path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(path, server?.url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: await signedIn(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  for (;;) {
    const value = await read();
    if (done(value)) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function environment(): Promise<Environment> {
  const [found] = await until(
    async () =>
      (await (await api("/api/environments")).json()) as Environment[],
    (environments) => environments.length > 0,
  );

  if (!found) {
    throw new Error("no environment");
  }

  return found;
}

const session = async (id: string): Promise<Session> =>
  (await (await api(`/api/sessions/${id}`)).json()) as Session;

const settled = (value: Session): boolean =>
  value.status === "idle" || value.status === "failed";

async function aliases(environmentId: string): Promise<void> {
  const response = await api(
    `/api/plugins/models/environments/${environmentId}`,
    {
      aliases: {
        models: {
          "medium-1": [
            `primary/${primary.getModel().id}`,
            `fallback/${fallback.getModel().id}`,
          ],
        },
      },
    },
  );

  expect(response.status).toBe(200);
}

test("routes an alias to its first model in the session's Environment", async () => {
  const { id: environmentId } = await environment();
  await aliases(environmentId);

  primary.setResponses([fauxAssistantMessage("from primary")]);

  const started = (await (
    await api("/api/sessions", {
      workspace: { kind: "folder", path: root },
      model: { provider: "alias", id: "medium-1" },
      firstMessage: "hi",
    })
  ).json()) as Session;

  expect((await until(async () => session(started.id), settled)).status).toBe(
    "idle",
  );

  expect(primary.state.callCount).toBe(1);
  expect(fallback.state.callCount).toBe(0);
});

test("takes a provider that hit its cap out of routing for the whole Environment", async () => {
  const { id: environmentId } = await environment();
  await aliases(environmentId);

  primary.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "402 insufficient_quota",
    }),
  ]);

  fallback.setResponses([fauxAssistantMessage("from fallback")]);

  const capped = (await (
    await api("/api/sessions", {
      workspace: { kind: "folder", path: root },
      model: { provider: "alias", id: "medium-1" },
      firstMessage: "hi",
    })
  ).json()) as Session;

  const [models] = await until(
    async () =>
      (await (
        await api("/api/plugins/models/environments")
      ).json()) as EnvironmentModels[],
    ([found]) =>
      found !== undefined && "primary" in found.health.unhealthyUntil,
  );

  expect(models?.health.unhealthyUntil["primary"]?.reason).toContain("402");

  const next = (await (
    await api("/api/sessions", {
      workspace: { kind: "folder", path: root },
      model: { provider: "alias", id: "medium-1" },
      firstMessage: "hi again",
    })
  ).json()) as Session;

  expect((await until(async () => session(next.id), settled)).status).toBe(
    "idle",
  );

  expect(fallback.state.callCount).toBe(1);
  expect(primary.state.callCount).toBe(1);

  await until(async () => session(capped.id), settled);
});

test("refuses an alias config without aliases or with a malformed one", async () => {
  const { id: environmentId } = await environment();

  for (const config of [
    { models: {} },
    { models: { "medium-1": [] } },
    { models: { "medium-1": ["no-provider"] } },
    { models: { "a/b": ["primary/m"] } },
    { models: { "medium-1": ["primary/m"] }, defaultAlias: "heavy-1" },
  ]) {
    const response = await api(
      `/api/plugins/models/environments/${environmentId}`,
      { aliases: config },
    );

    expect(response.status).toBe(400);
  }
});

test("refuses provider settings with the wrong types", async () => {
  const { id: environmentId } = await environment();

  for (const settings of [
    { capStatusCodes: 402 },
    { capStatusCodes: ["402"] },
    { resetSchedule: 1 },
  ]) {
    const response = await api(
      `/api/plugins/models/environments/${environmentId}`,
      {
        aliases: {
          models: { "medium-1": ["primary/m"] },
          providers: { primary: settings },
        },
      },
    );

    expect(response.status).toBe(400);
  }
});

test("lists an Environment's aliases first and gives a session with no model its default alias", async () => {
  const { id: environmentId } = await environment();

  await api(`/api/plugins/models/environments/${environmentId}`, {
    aliases: {
      defaultAlias: "medium-1",
      models: { "medium-1": [`primary/${primary.getModel().id}`] },
    },
  });

  const [listed] = (await (
    await api("/api/environments")
  ).json()) as Environment[];

  expect(listed?.models[0]).toEqual({ provider: "alias", id: "medium-1" });

  primary.setResponses([fauxAssistantMessage("from primary")]);

  const started = (await (
    await api("/api/sessions", {
      workspace: { kind: "folder", path: root },
      firstMessage: "hi",
    })
  ).json()) as Session;

  expect(started.model).toEqual({ provider: "alias", id: "medium-1" });

  expect((await until(async () => session(started.id), settled)).status).toBe(
    "idle",
  );
});
