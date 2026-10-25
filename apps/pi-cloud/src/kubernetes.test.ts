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
    creationTimestamp?: string;
  };
  readonly spec: {
    readonly containers: readonly {
      readonly image: string;
      readonly command: readonly string[];
    }[];
    readonly [field: string]: unknown;
  };
  status?: { phase: string };
}

interface Labelled {
  readonly metadata: { readonly labels: Record<string, string> };
}

// The pod, Secret and claim calls of the Kubernetes API, in memory.
function fakeApi(): {
  readonly url: string;
  readonly pods: Map<string, FakePod>;
  readonly secrets: Map<string, Record<string, string>>;
  readonly claims: Map<string, Labelled>;
  readonly stop: () => Promise<void>;
} {
  const pods = new Map<string, FakePod>();
  const secrets = new Map<string, Record<string, string>>();
  const claims = new Map<string, Labelled>();
  const prefix = "/api/v1/namespaces/pi";

  const stores: Record<string, Map<string, unknown>> = {
    pods,
    secrets,
    persistentvolumeclaims: claims,
  };

  const api = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);

      const [kind = "", name] = url.pathname
        .slice(prefix.length + 1)
        .split("/");

      const store = stores[kind];
      if (store === undefined) {
        return Response.json({}, { status: 404 });
      }

      if (request.method === "GET") {
        const selector = url.searchParams.get("labelSelector") ?? "";
        const [label = "", value] = selector.split("=");

        return Response.json({
          items: [...(store as Map<string, Labelled>).values()].filter(
            ({ metadata }) =>
              value === undefined
                ? label in metadata.labels
                : metadata.labels[label] === value,
          ),
        });
      }

      if (request.method === "POST") {
        const body = (await request.json()) as {
          metadata: { name: string };
          stringData?: Record<string, string>;
        };

        if (store.has(body.metadata.name)) {
          return Response.json({}, { status: 409 });
        }

        store.set(
          body.metadata.name,
          kind === "secrets" ? (body.stringData ?? {}) : body,
        );

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
    claims,
    stop: async () => api.stop(true),
  };
}

let root: string;
let api: ReturnType<typeof fakeApi>;
let server: ReturnType<typeof serve>;
let signedIn: () => Promise<string>;
let logs: string[];

function startServer(database = ":memory:"): void {
  // A server that stopped may still log to its own lines.
  const lines: string[] = [];
  logs = lines;

  server = serve({
    port: 0,
    database,
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
      lines.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-cloud-k8s-")));
  api = fakeApi();
  startServer();
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
    "POST",
    `/api/plugins/kubernetes/environments/${environment.id}`,
    { settings },
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
    call("POST", path, { settings: { capacity: 0 } }),
    call("POST", path, { settings: { podPatch: [] } }),
    call("POST", path, { settings: { workspace: "disk" } }),
    call("POST", path, { settings: { claimSize: "lots" } }),
    call("POST", path, { capacity: 1 }),
    call("POST", "/api/plugins/kubernetes/environments/nope", {
      settings: {},
    }),
  ]);

  const unsaved = await (await call("GET", path)).json();

  await call("PATCH", `/api/environments/${environment.id}`, {
    isolation: "container",
  });

  const inContainers = await call("POST", path, { settings: {} });

  expect(responses.map(({ status }) => status)).toEqual([
    400, 400, 400, 400, 400, 404,
  ]);

  expect(unsaved).toEqual({ settings: null, startsPods: true });
  expect(inContainers.status).toBe(409);
});

test("keeps a pod patch from giving runner pods a service account token", async () => {
  const environment = await kubernetesEnvironment({
    podPatch: {
      spec: {
        serviceAccountName: "pi-cloud",
        automountServiceAccountToken: true,
        nodeSelector: { pool: "agents" },
      },
    },
  });

  await startSession(environment);
  await eventually(() => api.pods.size === 1);

  const [pod] = api.pods.values();

  expect(pod?.spec).toMatchObject({
    automountServiceAccountToken: false,
    nodeSelector: { pool: "agents" },
  });

  expect(pod?.spec["serviceAccountName"]).toBeUndefined();
});

test("removes a runner pod that never starts, and starts another", async () => {
  const environment = await kubernetesEnvironment({});
  await startSession(environment);
  await eventually(() => api.pods.size === 1);

  const [first] = api.pods.values();
  if (first) {
    first.metadata.creationTimestamp = new Date(
      Date.now() - 60 * 60_000,
    ).toISOString();
  }

  await eventually(
    () =>
      first !== undefined &&
      !api.pods.has(first.metadata.name) &&
      api.pods.size === 1,
  );

  expect(api.secrets.size).toBe(1);
});

test("removes stopped runner pods of an Environment whose settings were removed", async () => {
  const environment = await kubernetesEnvironment({});
  await startSession(environment);
  await eventually(() => api.pods.size === 1);

  await call("POST", `/api/plugins/kubernetes/environments/${environment.id}`, {
    settings: null,
  });

  const [pod] = api.pods.values();
  if (pod) {
    pod.status = { phase: "Succeeded" };
  }

  await eventually(() => api.pods.size === 0 && api.secrets.size === 0);
});

test("reconciles saved settings once the server starts again", async () => {
  const database = join(root, "server.db");
  await server.stop();
  startServer(database);

  const environment = await kubernetesEnvironment({});
  const cookie = await signedIn();
  await server.stop();
  startServer(database);
  signedIn = async () => Promise.resolve(cookie);

  await startSession(environment);
  await eventually(() => api.pods.size === 1);

  expect(logs.filter((line) => line.includes("not reconciled"))).toEqual([]);
});

async function startRunner(
  name: string,
  session: string,
  signal: AbortSignal,
): Promise<void> {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("hi from a pod")])]);

  return ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  }).then(async (runtime) => {
    runtime.registerNativeProvider(faux.provider);

    await runAgent({
      server: server.url.href,
      provider: name,
      credential: { token: api.secrets.get(name)?.["token"] ?? "" },
      session,
      dataDir: join(root, name),
      extensionPaths: [],
      folders: [root],
      models: { runtime, model: faux.getModel() },
      log: () => undefined,
      signal,
    });
  });
}

async function sessionOf(id: string): Promise<Session> {
  return (await (await call("GET", `/api/sessions/${id}`)).json()) as Session;
}

test("gives each Session a pod of its own that mounts its claim, and brings it back once deleted", async () => {
  const environment = await kubernetesEnvironment({
    workspace: "claim",
    claimSize: "1Gi",
  });

  const first = await startSession(environment);
  const second = await startSession(environment);
  await eventually(() => api.pods.size === 2);

  const name = `pi-session-${second.id}`;
  const pod = api.pods.get(name);
  const token = api.secrets.get(name)?.["token"];
  const stop = new AbortController();
  const runner = startRunner(name, second.id, stop.signal);

  for (let attempt = 0; attempt < 250; attempt++) {
    const current = await sessionOf(second.id);
    if (current.runner === name && current.status === "idle") {
      break;
    }

    await sleep(20);
  }

  const heldFirst = await sessionOf(first.id);

  api.pods.delete(name);
  stop.abort();
  await runner.catch(() => undefined);

  await eventually(
    () =>
      api.pods.has(name) &&
      api.secrets.get(name)?.["token"] !== undefined &&
      api.secrets.get(name)?.["token"] !== token,
  );

  expect([...api.claims.keys()].sort()).toEqual(
    [`pi-session-${first.id}`, name].sort(),
  );

  expect(pod?.spec["volumes"]).toContainEqual({
    name: "home",
    persistentVolumeClaim: { claimName: name },
  });

  expect(pod?.spec.containers[0]?.command.slice(-6)).toEqual([
    "--capacity",
    "1",
    "--exit-when-idle",
    "300",
    "--session",
    second.id,
  ]);

  expect(heldFirst).toMatchObject({ runner: null, status: "queued" });
  expect(await sessionOf(second.id)).toMatchObject({ runner: name });

  await call("POST", `/api/sessions/${second.id}/archive`, {});

  const back = api.pods.get(name);
  if (back) {
    back.status = { phase: "Succeeded" };
  }

  await eventually(() => !api.claims.has(name) && !api.pods.has(name));

  expect(api.claims.has(`pi-session-${first.id}`)).toBe(true);
}, 30_000);
