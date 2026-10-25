import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Environment, Session, SessionEvent } from "@pi-cloud/protocol";
import { runAgent } from "./agent";
import { readSse } from "./sse";
import { setupTokenOf } from "./testdata/sign-in";

// Runs against the Helm chart installed in the current kubectl context, as
// CI does on kind. The agent runs here, on Pi's faux model.
const release = process.env["PI_CLOUD_RELEASE"] ?? "pi-cloud";
const server = new URL("http://127.0.0.1:17420");
const faux = fauxProvider({ models: [{ id: "faux-1" }] });

let root: string;
let forward: ChildProcess | undefined;
let cookie = "";
const stopAgent = new AbortController();
let agentDone: Promise<void> | undefined;

function kubectl(...args: string[]): string {
  return execFileSync("kubectl", args, { encoding: "utf8" });
}

async function forwardPort(): Promise<void> {
  forward?.kill();

  forward = spawn(
    "kubectl",
    ["port-forward", `svc/${release}`, `${server.port}:7420`],
    { stdio: "ignore" },
  );

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(new URL("/healthz", server))).ok) {
        return;
      }
    } catch {
      // Not forwarding yet.
    }

    await Bun.sleep(200);
  }

  throw new Error("the server never answered through the port forward");
}

async function api(path: string, body?: unknown): Promise<Response> {
  const response = await fetch(new URL(path, server), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    throw new Error(`${path} returned ${String(response.status)}`);
  }

  return response;
}

async function until(
  sessionId: string,
  done: (events: readonly SessionEvent[]) => boolean,
): Promise<void> {
  const controller = new AbortController();

  const response = await fetch(
    new URL(`/api/sessions/${sessionId}/events`, server),
    { signal: controller.signal, headers: { cookie } },
  );

  const events: SessionEvent[] = [];
  for await (const event of readSse(response)) {
    events.push(event as SessionEvent);
    if (done(events)) {
      break;
    }
  }

  controller.abort();
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-cloud-kind-")));
  await forwardPort();

  const setUp = await fetch(new URL("/api/auth/setup", server), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: setupTokenOf(kubectl("logs", `deploy/${release}`).split("\n")),
      name: "pedro",
      password: "correct horse",
    }),
  });

  cookie = setUp.headers.get("set-cookie")?.split(";")[0] ?? "";
});

afterAll(async () => {
  stopAgent.abort();
  await agentDone?.catch(() => undefined);
  forward?.kill();
  await rm(root, { recursive: true, force: true });
});

test("runs a Session from an agent that joined with its Environment's key", async () => {
  const { environment, key } = (await (
    await api("/api/environments", { name: "kind" })
  ).json()) as { environment: Environment; key: string };

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText("hello from kind")])]);

  agentDone = runAgent({
    server: server.href,
    provider: "laptop",
    credential: { key },
    dataDir: join(root, "agent"),
    extensionPaths: [],
    folders: [root],
    models: { runtime, model: faux.getModel() },
    log: () => undefined,
    signal: stopAgent.signal,
  });

  const session = (await (
    await api("/api/sessions", {
      environment: environment.id,
      workspace: { kind: "folder", path: root },
    })
  ).json()) as Session;

  await until(session.id, (events) =>
    events.some(
      (event) => event.type === "session" && event.session.status === "idle",
    ),
  );

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "hi",
  });

  await until(session.id, (events) =>
    events.some(
      (event) =>
        event.type === "entry" &&
        JSON.stringify(event.entry).includes("hello from kind"),
    ),
  );
}, 60_000);

test("keeps users and Environment secrets when the pod restarts", async () => {
  const [environment] = (await (
    await api("/api/environments")
  ).json()) as Environment[];

  const updated = await fetch(
    new URL(`/api/environments/${environment?.id ?? ""}`, server),
    {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ secrets: { GH_TOKEN: "ghp_kind" } }),
    },
  );

  expect(updated.status).toBe(200);

  kubectl("rollout", "restart", `deploy/${release}`);
  kubectl("rollout", "status", `deploy/${release}`, "--timeout=120s");
  await forwardPort();

  const after = (await (
    await api("/api/environments")
  ).json()) as Environment[];

  expect(after.find(({ id }) => id === environment?.id)?.secrets).toEqual([
    "GH_TOKEN",
  ]);

  expect(kubectl("logs", `deploy/${release}`)).not.toContain("#setup/");
}, 180_000);
