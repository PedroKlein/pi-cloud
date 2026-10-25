import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { kubernetes } from "@pi-cloud/kubernetes/server";
import type { Environment, Session } from "@pi-cloud/protocol";
import { runAgent } from "./agent";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";

interface FakePod {
  readonly metadata: {
    readonly name: string;
    readonly labels: Record<string, string>;
  };
  readonly spec: {
    readonly containers: readonly {
      readonly image: string;
      readonly command: readonly string[];
    }[];
  };
  status?: { phase: string };
}

// The pod and Secret calls of the Kubernetes API, in memory.
function fakeApi(): {
  readonly url: string;
  readonly pods: Map<string, FakePod>;
  readonly secrets: Map<string, Record<string, string>>;
  readonly stop: () => Promise<void>;
} {
  const pods = new Map<string, FakePod>();
  const secrets = new Map<string, Record<string, string>>();
  const prefix = "/api/v1/namespaces/pi";

  const api = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const [kind, name] = url.pathname.slice(prefix.length + 1).split("/");
      const store = kind === "pods" ? pods : secrets;

      if (request.method === "GET" && kind === "pods") {
        const selector = url.searchParams.get("labelSelector") ?? "";
        const [label = "", value] = selector.split("=");

        return Response.json({
          items: [...pods.values()].filter(
            (pod) => pod.metadata.labels[label] === value,
          ),
        });
      }

      if (request.method === "POST") {
        const body = (await request.json()) as {
          metadata: { name: string };
          stringData?: Record<string, string>;
        };

        if (kind === "pods") {
          pods.set(body.metadata.name, body as unknown as FakePod);
        } else {
          secrets.set(body.metadata.name, body.stringData ?? {});
        }

        return Response.json(body, { status: 201 });
      }

      if (request.method === "DELETE" && name !== undefined) {
        return store.delete(name)
          ? Response.json({})
          : Response.json({}, { status: 404 });
      }

      return Response.json({}, { status: 405 });
    },
  });

  return {
    url: api.url.href.replace(/\/$/, ""),
    pods,
    secrets,
    stop: async () => api.stop(true),
  };
}

let root: string;
let api: ReturnType<typeof fakeApi>;
let server: ReturnType<typeof serve>;
let signedIn: () => Promise<string>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-cloud-k8s-")));
  api = fakeApi();
  const logs: string[] = [];

  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 100, offlineAfterMs: 1000 },
    plugins: [
      kubernetes(() => ({
        api: { url: api.url, namespace: "pi", token: () => "t" },
        image: "pi-cloud:test",
        server: "http://pi-cloud:7420",
        variables: { PI_CLOUD_FAUX_REPLY: "hi" },
        intervalMs: 20,
      })),
    ],
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
});

afterEach(async () => {
  await server.stop();
  await api.stop();
  await rm(root, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method,
    headers: { "content-type": "application/json", cookie: await signedIn() },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function kubernetesEnvironment(settings: object): Promise<Environment> {
  const { environment } = (await (
    await call("POST", "/api/environments", { name: "pods" })
  ).json()) as { environment: Environment };

  const saved = await call(
    "PUT",
    `/api/plugins/kubernetes/environments/${environment.id}`,
    settings,
  );

  expect(saved.status).toBe(200);

  return environment;
}

async function startSession(environment: Environment): Promise<Session> {
  return (await (
    await call("POST", "/api/sessions", {
      environment: environment.id,
      workspace: { kind: "folder", path: root },
    })
  ).json()) as Session;
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (check()) {
      return;
    }

    await sleep(20);
  }

  throw new Error("timed out");
}

test("starts one runner pod per Session no runner can take, up to the most allowed", async () => {
  const environment = await kubernetesEnvironment({ capacity: 1, maxPods: 2 });

  await startSession(environment);
  await eventually(() => api.pods.size === 1);
  await sleep(200);

  expect(api.pods.size).toBe(1);

  await startSession(environment);
  await startSession(environment);
  await eventually(() => api.pods.size === 2);
  await sleep(200);

  const [pod] = api.pods.values();

  expect(api.pods.size).toBe(2);
  expect([...api.secrets.keys()].sort()).toEqual([...api.pods.keys()].sort());
  expect(pod?.metadata.labels["pi-cloud.dev/environment"]).toBe(environment.id);

  expect(pod?.spec.containers[0]).toMatchObject({
    image: "pi-cloud:test",
    command: [
      "/pi-cloud/pi-cloud",
      "agent",
      "--name",
      pod?.metadata.name,
      "--server",
      "http://pi-cloud:7420",
      "--capacity",
      "1",
      "--exit-when-idle",
      "300",
    ],
  });
});

test("lets the runner in a started pod run the Session, and removes the pod once it stops", async () => {
  const environment = await kubernetesEnvironment({});
  const session = await startSession(environment);
  await eventually(() => api.pods.size === 1);

  const [name = ""] = api.pods.keys();
  const token = api.secrets.get(name)?.["token"] ?? "";
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("hi from a pod")])]);

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  const agent = runAgent({
    server: server.url.href,
    provider: name,
    credential: { token },
    dataDir: join(root, name),
    extensionPaths: [],
    folders: [root],
    models: { runtime, model: faux.getModel() },
    log: () => undefined,
    signal: AbortSignal.timeout(30_000),
  });

  for (let attempt = 0; attempt < 250; attempt++) {
    const current = (await (
      await call("GET", `/api/sessions/${session.id}`)
    ).json()) as Session;

    if (current.runner === name && current.status === "idle") {
      break;
    }

    await sleep(20);
  }

  const pod = api.pods.get(name);
  if (pod) {
    pod.status = { phase: "Succeeded" };
  }

  const stopped = await agent.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(stopped).toEqual(new Error("the server let this runner go"));
  await eventually(() => api.pods.size === 0 && api.secrets.size === 0);
}, 30_000);

test("refuses Kubernetes settings it can't use", async () => {
  const { environment } = (await (
    await call("POST", "/api/environments", { name: "pods" })
  ).json()) as { environment: Environment };

  const path = `/api/plugins/kubernetes/environments/${environment.id}`;

  const responses = await Promise.all([
    call("PUT", path, { capacity: 0 }),
    call("PUT", path, { podPatch: [] }),
    call("PUT", "/api/plugins/kubernetes/environments/nope", {}),
    call("GET", path),
  ]);

  expect(responses.map(({ status }) => status)).toEqual([400, 400, 404, 404]);
});
