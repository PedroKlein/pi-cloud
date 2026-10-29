import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Environment, Session } from "@pipoca/protocol";
import { runAgent } from "./agent";
import { supervised } from "./restart";
import { serve, type ServeOptions } from "./serve";
import { firstUser } from "./testdata/sign-in";

let root: string | undefined;
let server: ReturnType<typeof serve> | undefined;
let cookie = "";

afterEach(async () => {
  await server?.stop();
  server = undefined;

  if (root !== undefined) {
    await rm(root, { recursive: true, force: true });
  }
});

async function start(options: Partial<ServeOptions> = {}): Promise<void> {
  const logs: string[] = [];

  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 100 },
    ...options,
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  cookie = await firstUser(server, logs)();
}

async function api(path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(path, server?.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

test("restarts when something starts the server again", async () => {
  let restarted = false;

  await start({
    restart: () => {
      restarted = true;
    },
  });

  expect((await api("/api/restart", {})).status).toBe(202);

  await Bun.sleep(200);
  expect(restarted).toBe(true);
});

test("says to restart by hand when nothing would start the server again", async () => {
  await start();

  const refused = await api("/api/restart", {});

  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain("restart it yourself");
});

test("asks first while a Session on the server's own runner is mid-turn", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-restart-")));
  const faux = fauxProvider();

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  let finish = (): void => undefined;

  const answered = new Promise<void>((resolve) => {
    finish = resolve;
  });

  faux.setResponses([
    async () => {
      await answered;

      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);

  let restarted = 0;

  await start({
    agent: {
      provider: "local",
      dataDir: join(root, "local"),
      extensionPaths: [],
      folders: [root],
      models: { runtime, model: faux.getModel() },
    },
    restart: () => {
      restarted += 1;
    },
  });

  while (
    ((await (await api("/api/environments")).json()) as unknown[]).length === 0
  ) {
    await Bun.sleep(10);
  }

  const session = (await (
    await api("/api/sessions", {
      workspace: { kind: "folder", path: root },
      firstMessage: "Take your time",
    })
  ).json()) as Session;

  while (
    ((await (await api(`/api/sessions/${session.id}`)).json()) as Session)
      .status !== "running"
  ) {
    await Bun.sleep(20);
  }

  const asked = await api("/api/restart", {});

  expect(asked.status).toBe(409);
  expect(await asked.json()).toEqual({ error: "busy", sessions: 1 });

  expect((await api("/api/restart", { force: true })).status).toBe(202);

  await Bun.sleep(200);
  expect(restarted).toBe(1);
  finish();
});

test("counts a Session its own runner is starting, and none of another runner's", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-restart-")));
  const own = join(root, "own");
  const other = join(root, "other");
  const ready = join(root, "ready");
  await Promise.all([mkdir(own), mkdir(other)]);

  const faux = fauxProvider();

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  let finish = (): void => undefined;

  const answered = new Promise<void>((resolve) => {
    finish = resolve;
  });

  faux.setResponses([
    async () => {
      await answered;

      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);

  const models = { runtime, model: faux.getModel() };

  await start({
    agent: {
      provider: "local",
      dataDir: join(root, "local"),
      extensionPaths: [],
      folders: [own],
      models,
    },
    restart: () => undefined,
  });

  let environment: Environment | undefined;
  while (environment === undefined) {
    [environment] = (await (
      await api("/api/environments")
    ).json()) as Environment[];

    await Bun.sleep(10);
  }

  await fetch(new URL(`/api/environments/${environment.id}`, server?.url), {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      setupScript: `while [ ! -f "${ready}" ]; do sleep 0.05; done`,
    }),
  });

  const { key } = (await (
    await api(`/api/environments/${environment.id}/key`, {})
  ).json()) as { key: string };

  const stopOther = new AbortController();

  const otherRunner = runAgent({
    server: server?.url.href ?? "",
    provider: "other",
    credential: { key },
    dataDir: join(root, "other-data"),
    extensionPaths: [],
    folders: [other],
    models,
    log: () => undefined,
    signal: stopOther.signal,
  });

  const created = async (path: string, firstMessage?: string) =>
    (await (
      await api("/api/sessions", {
        workspace: { kind: "folder", path },
        ...(firstMessage !== undefined && { firstMessage }),
      })
    ).json()) as Session;

  const reaches = async (id: string, status: Session["status"]) => {
    while (
      ((await (await api(`/api/sessions/${id}`)).json()) as Session).status !==
      status
    ) {
      await Bun.sleep(20);
    }
  };

  const starting = await created(own);
  await reaches(starting.id, "starting");

  const whileStarting = await api("/api/restart", {});

  await writeFile(ready, "");
  await reaches(starting.id, "idle");

  const elsewhere = await created(other, "Take your time");
  await reaches(elsewhere.id, "running");

  const whileOtherRuns = await api("/api/restart", {});

  expect([whileStarting.status, whileOtherRuns.status]).toEqual([409, 202]);

  finish();
  stopOther.abort();
  await otherRunner;
}, 30_000);

test("leaves no supervisor mark for a server started inside a Session", () => {
  const env: NodeJS.ProcessEnv = { INVOCATION_ID: "abc", PATH: "/bin" };

  expect(supervised(env)).toBe(true);
  expect(env).toEqual({ PATH: "/bin" });
  expect(supervised(env)).toBe(false);
});
