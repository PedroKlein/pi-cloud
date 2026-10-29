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
import { kubernetes } from "@pipoca/kubernetes/server";
import {
  type Environment,
  protocolVersion,
  type Session,
  versionHeader,
} from "@pipoca/protocol";
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
  status?: {
    phase: string;
    containerStatuses?: readonly object[];
    initContainerStatuses?: readonly object[];
  };
}

interface Labelled {
  readonly metadata: { readonly labels: Record<string, string> };
}

interface FakeSecret extends Labelled {
  readonly stringData: Record<string, string>;
}

// The pod, Secret and claim calls of the Kubernetes API, in memory.
function fakeApi(): {
  readonly url: string;
  readonly pods: Map<string, FakePod>;
  readonly secrets: Map<string, FakeSecret>;
  readonly claims: Map<string, Labelled>;
  // Objects whose delete fails, as on an API server that is down for them.
  readonly undeletable: Set<string>;
  // Objects whose delete answers only after a while, as on a busy API server.
  readonly slow: Set<string>;
  readonly stop: () => Promise<void>;
} {
  const pods = new Map<string, FakePod>();
  const secrets = new Map<string, FakeSecret>();
  const claims = new Map<string, Labelled>();
  const undeletable = new Set<string>();
  const slow = new Set<string>();
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

      if (request.method === "GET" && name !== undefined) {
        const found = store.get(name);

        return found === undefined
          ? Response.json({}, { status: 404 })
          : Response.json(found);
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
        };

        if (store.has(body.metadata.name)) {
          return Response.json({}, { status: 409 });
        }

        store.set(body.metadata.name, body);

        return Response.json(body, { status: 201 });
      }

      if (request.method === "DELETE" && undeletable.has(name ?? "")) {
        return Response.json({}, { status: 500 });
      }

      if (request.method === "DELETE" && name !== undefined) {
        if (slow.has(name)) {
          await sleep(200);
        }

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
    undeletable,
    slow,
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
        image: "pipoca:test",
        imagePullPolicy: "Always",
        server: "http://pipoca:7420",
        pod: "pipoca-server",
        variables: { PIPOCA_FAUX_REPLY: "hi" },
        intervalMs: 20,
        retryAfterMs: 300,
      })),
    ],
    log: (message, fields) => {
      lines.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-k8s-")));
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

async function lastFailure(
  environment: Environment,
): Promise<{ readonly problem: string } | null> {
  const answer = (await (
    await call("GET", `/api/plugins/kubernetes/environments/${environment.id}`)
  ).json()) as { readonly lastFailure: { readonly problem: string } | null };

  return answer.lastFailure;
}

function failAll(): void {
  for (const pod of api.pods.values()) {
    pod.status = { phase: "Failed" };
  }
}

test("reads an Environment that starts runner pods as on demand, not offline", async () => {
  const environments = async (): Promise<readonly Environment[]> =>
    (await (await call("GET", "/api/environments")).json()) as Environment[];

  const { environment: plain } = (await (
    await call("POST", "/api/environments", { name: "plain" })
  ).json()) as { environment: Environment };

  const pods = await kubernetesEnvironment({ capacity: 1, maxPods: 2 });

  const listed = await environments();

  expect(listed.find(({ id }) => id === pods.id)).toMatchObject({
    online: false,
    onDemand: true,
  });

  expect(listed.find(({ id }) => id === plain.id)?.onDemand).toBe(false);

  await call("POST", `/api/plugins/kubernetes/environments/${pods.id}`, {
    settings: null,
  });

  expect(
    (await environments()).find(({ id }) => id === pods.id)?.onDemand,
  ).toBe(false);
});

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
  expect(pod?.metadata.labels["pipoca.dev/environment"]).toBe(environment.id);

  expect(
    api.secrets.get(pod?.metadata.name ?? "")?.metadata.labels[
      "pipoca.dev/environment"
    ],
  ).toBe(environment.id);

  expect(pod?.spec.containers[0]).toMatchObject({
    image: "pipoca:test",
    command: [
      "/pipoca/pipoca",
      "agent",
      "--name",
      pod?.metadata.name,
      "--server",
      "http://pipoca:7420",
      "--capacity",
      "1",
      "--exit-when-idle",
      "300",
    ],
  });
});

test("lets the runner in a started pod run the Session, and forgets an earlier failed pod once it joins", async () => {
  const environment = await kubernetesEnvironment({});
  const path = `/api/plugins/kubernetes/environments/${environment.id}`;
  const session = await startSession(environment);
  await eventually(() => api.pods.size === 1);

  const [failed] = api.pods.values();
  if (failed) {
    failed.status = { phase: "Failed" };
  }

  await eventually(
    () => api.pods.size === 1 && !api.pods.has(failed?.metadata.name ?? ""),
  );

  const [name = ""] = api.pods.keys();
  const token = api.secrets.get(name)?.stringData["token"] ?? "";
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

  await sleep(100);

  const whileRunning = (await (await call("GET", path)).json()) as {
    readonly lastFailure: unknown;
  };

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

  const afterStop = (await (await call("GET", path)).json()) as {
    readonly lastFailure: unknown;
  };

  expect(whileRunning.lastFailure).toBeNull();
  expect(afterStop.lastFailure).toBeNull();
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

  expect(unsaved).toEqual({
    settings: null,
    startsPods: true,
    lastFailure: null,
  });

  expect(inContainers.status).toBe(409);
});

test("keeps a pod patch from giving runner pods a service account token", async () => {
  const environment = await kubernetesEnvironment({
    podPatch: {
      spec: {
        serviceAccountName: "pipoca",
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

test("copies the binary from the Pipoca image pulled as the server's own", async () => {
  const environment = await kubernetesEnvironment({});
  await startSession(environment);
  await eventually(() => api.pods.size === 1);

  const [pod] = api.pods.values();

  expect(pod?.spec["initContainers"]).toMatchObject([
    { image: "pipoca:test", imagePullPolicy: "Always" },
  ]);
});

test("gives runner pods a home their user can write and leaves the mesh sidecar to the namespace", async () => {
  const environment = await kubernetesEnvironment({ workspace: "claim" });
  await startSession(environment);
  await eventually(() => api.pods.size === 1);

  const [pod] = api.pods.values();

  expect(pod?.spec["securityContext"]).toEqual({ fsGroup: 1000 });
  expect(pod?.metadata.labels).not.toHaveProperty("sidecar.istio.io/inject");
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

    first.status = {
      phase: "Pending",
      containerStatuses: [
        {
          name: "runner",
          state: {
            waiting: {
              reason: "ImagePullBackOff",
              message: 'Back-off pulling image "nope:1"',
            },
          },
        },
      ],
    };
  }

  await eventually(
    () =>
      first !== undefined &&
      !api.pods.has(first.metadata.name) &&
      api.pods.size === 1,
  );

  const failure = await lastFailure(environment);

  expect(api.secrets.size).toBe(1);

  expect(failure?.problem).toBe(
    'runner is waiting: Back-off pulling image "nope:1"',
  );
});

test("waits longer for a new runner pod after each one that fails, and says why", async () => {
  const environment = await kubernetesEnvironment({});
  await startSession(environment);

  const fail = async (): Promise<number> => {
    await eventually(() => api.pods.size === 1);

    const [pod] = api.pods.values();
    if (pod) {
      pod.status = {
        phase: "Failed",
        containerStatuses: [
          {
            name: "runner",
            state: {
              terminated: {
                exitCode: 1,
                message: "EACCES: permission denied, mkdir '/home/pi'",
              },
            },
          },
        ],
      };
    }

    await eventually(() => api.pods.size === 0);
    const failedAt = Date.now();
    await eventually(() => api.pods.size === 1);

    return Date.now() - failedAt;
  };

  const firstWait = await fail();
  const secondWait = await fail();

  const failure = await lastFailure(environment);

  expect(firstWait).toBeGreaterThanOrEqual(250);
  expect(secondWait).toBeGreaterThanOrEqual(550);

  expect(failure?.problem).toBe(
    "runner exited with 1: EACCES: permission denied, mkdir '/home/pi'",
  );
});

test("counts a runner pod whose agent never reached the server as failed", async () => {
  const environment = await kubernetesEnvironment({});
  await startSession(environment);
  await eventually(() => api.pods.size === 1);

  const [pod] = api.pods.values();
  if (pod) {
    api.slow.add(pod.metadata.name);
    pod.status = { phase: "Succeeded" };
  }

  await eventually(() => api.pods.size === 0);

  const failure = await lastFailure(environment);

  expect(failure?.problem).toBe(
    "its agent never reached the server at http://pipoca:7420",
  );
});

test("counts runner pods that fail together as one failure", async () => {
  const environment = await kubernetesEnvironment({ maxPods: 3 });
  await Promise.all([1, 2, 3].map(async () => startSession(environment)));
  await eventually(() => api.pods.size === 3);

  failAll();
  await eventually(() => api.pods.size === 0);
  const failedAt = Date.now();
  await eventually(() => api.pods.size > 0);

  expect(Date.now() - failedAt).toBeLessThan(550);
});

test("holds back only the Session whose own pod failed", async () => {
  const environment = await kubernetesEnvironment({ workspace: "claim" });
  const first = await startSession(environment);
  await eventually(() => api.pods.size === 1);

  failAll();
  await eventually(() => api.pods.size === 0);

  const second = await startSession(environment);
  await eventually(() => api.pods.has(`pi-session-${second.id}`));

  expect(api.pods.has(`pi-session-${first.id}`)).toBe(false);
});

test("forgets a failure once the Environment's settings are saved again", async () => {
  const environment = await kubernetesEnvironment({});
  await startSession(environment);
  await eventually(() => api.pods.size === 1);

  failAll();
  await eventually(() => api.pods.size === 0);
  const failed = await lastFailure(environment);

  await call("POST", `/api/plugins/kubernetes/environments/${environment.id}`, {
    settings: { idleSeconds: 120 },
  });

  expect(failed).not.toBeNull();
  expect(await lastFailure(environment)).toBeNull();
});

test("doesn't count a pod made before the server started that never reached it", async () => {
  const environment = await kubernetesEnvironment({});

  api.pods.set("pi-runner-0ld", {
    metadata: {
      name: "pi-runner-0ld",
      labels: { "pipoca.dev/environment": environment.id },
      creationTimestamp: new Date(Date.now() - 60_000).toISOString(),
    },
    spec: { containers: [] },
    status: { phase: "Succeeded" },
  });

  await eventually(() => !api.pods.has("pi-runner-0ld"));

  expect(await lastFailure(environment)).toBeNull();
});

test("revokes the token of a runner pod deleted from outside, and deletes its Secret", async () => {
  const environment = await kubernetesEnvironment({});
  await startSession(environment);
  await eventually(() => api.pods.size === 1);

  const [name = ""] = api.pods.keys();
  const token = api.secrets.get(name)?.stringData["token"] ?? "";
  api.pods.delete(name);

  await eventually(() => !api.secrets.has(name) && api.pods.size === 1);

  const work = await fetch(new URL("/agent/work", server.url), {
    method: "POST",
    headers: {
      [versionHeader]: String(protocolVersion),
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ running: [], folders: [], models: [] }),
  });

  expect(work.status).toBe(401);
  expect([...api.secrets.keys()]).toEqual([...api.pods.keys()]);
});

test("keeps starting runner pods while one stopped pod can't be deleted", async () => {
  const environment = await kubernetesEnvironment({});

  api.undeletable.add("pi-runner-stuck");

  api.pods.set("pi-runner-stuck", {
    metadata: {
      name: "pi-runner-stuck",
      labels: { "pipoca.dev/environment": environment.id },
      creationTimestamp: new Date(Date.now() - 60_000).toISOString(),
    },
    spec: { containers: [] },
    status: { phase: "Succeeded" },
  });

  // A pass that listed pods before this one was added could start the next
  // pod without ever trying to delete it.
  await eventually(() =>
    logs.some(
      (line) =>
        line.includes("pi-runner-stuck") && line.includes("not removed"),
    ),
  );

  await startSession(environment);
  await eventually(() => api.pods.size === 2);

  expect(api.pods.has("pi-runner-stuck")).toBe(true);
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
      credential: { token: api.secrets.get(name)?.stringData["token"] ?? "" },
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
  const token = api.secrets.get(name)?.stringData["token"];
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
      api.secrets.get(name)?.stringData["token"] !== undefined &&
      api.secrets.get(name)?.stringData["token"] !== token,
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

test("keeps an archived Session's claim while its workspace is kept, until forced", async () => {
  const environment = await kubernetesEnvironment({ workspace: "claim" });

  const session = (await (
    await call("POST", "/api/sessions", {
      environment: environment.id,
      workspace: { kind: "clone", repository: "https://example.com/r.git" },
    })
  ).json()) as Session;

  const name = `pi-session-${session.id}`;
  await eventually(() => api.pods.has(name) && api.claims.has(name));

  const archived = (await (
    await call("POST", `/api/sessions/${session.id}/archive`, {})
  ).json()) as Session;

  const reported = await fetch(
    new URL(`/agent/sessions/${session.id}/workspace`, server.url),
    {
      method: "POST",
      headers: {
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${api.secrets.get(name)?.stringData["token"] ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        generation: archived.generation,
        outcome: "kept",
        reason: "uncommitted changes",
      }),
    },
  );

  const pod = api.pods.get(name);
  if (pod) {
    pod.status = { phase: "Succeeded" };
  }

  await eventually(() => !api.pods.has(name));
  await sleep(200);

  expect(reported.status).toBe(204);
  expect((await sessionOf(session.id)).workspaceRemoval).toBe("kept");
  expect(api.claims.has(name)).toBe(true);

  await call("POST", `/api/sessions/${session.id}/remove-workspace`, {});
  await eventually(() => !api.claims.has(name));
});

test("replaces a runner pod whose spec names an older Pipoca image, keeping its claim", async () => {
  const environment = await kubernetesEnvironment({ workspace: "claim" });
  const old = await startSession(environment);
  const current = await startSession(environment);
  const oldName = `pi-session-${old.id}`;
  const currentName = `pi-session-${current.id}`;
  await eventually(() => api.pods.has(oldName) && api.pods.has(currentName));

  const oldToken = api.secrets.get(oldName)?.stringData["token"] ?? "";
  const currentToken = api.secrets.get(currentName)?.stringData["token"];
  const currentPod = api.pods.get(currentName);
  const started = api.pods.get(oldName);

  const upgraded: FakePod = {
    metadata: started?.metadata ?? { name: oldName, labels: {} },
    spec: {
      ...started?.spec,
      containers: started?.spec.containers ?? [],
      initContainers: [{ name: "pipoca", image: "pipoca:old" }],
    },
    status: { phase: "Running" },
  };

  api.pods.set(oldName, upgraded);

  await eventually(
    () =>
      api.pods.has(oldName) &&
      api.pods.get(oldName) !== upgraded &&
      api.secrets.get(oldName)?.stringData["token"] !== undefined &&
      api.secrets.get(oldName)?.stringData["token"] !== oldToken,
  );

  await sleep(200);

  const work = await fetch(new URL("/agent/work", server.url), {
    method: "POST",
    headers: {
      [versionHeader]: String(protocolVersion),
      authorization: `Bearer ${oldToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ running: [], folders: [], models: [] }),
  });

  expect(api.pods.get(oldName)?.spec["initContainers"]).toMatchObject([
    { image: "pipoca:test" },
  ]);

  expect(work.status).toBe(401);
  expect([...api.claims.keys()].sort()).toEqual([oldName, currentName].sort());
  expect(api.pods.get(currentName)).toBe(currentPod);
  expect(api.secrets.get(currentName)?.stringData["token"]).toBe(currentToken);

  expect(
    logs.filter((line) => line.includes("runner pod replaced")),
  ).toHaveLength(1);
});

test("replaces a runner pod whose node ran another digest of the same moving tag, keeping its claim", async () => {
  const ran = (pod: FakePod | undefined, imageId: string): void => {
    if (pod) {
      pod.status = {
        phase: "Running",
        initContainerStatuses: [
          { name: "pipoca", image: "pipoca:test", imageID: imageId },
        ],
      };
    }
  };

  api.pods.set("pipoca-server", {
    metadata: { name: "pipoca-server", labels: {} },
    spec: { containers: [{ image: "pipoca:test", command: [] }] },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "server",
          image: "pipoca:test",
          imageID: "registry/pipoca@sha256:new",
        },
      ],
    },
  });

  const environment = await kubernetesEnvironment({ workspace: "claim" });
  const old = await startSession(environment);
  const current = await startSession(environment);
  const oldName = `pi-session-${old.id}`;
  const currentName = `pi-session-${current.id}`;
  await eventually(() => api.pods.has(oldName) && api.pods.has(currentName));

  const oldPod = api.pods.get(oldName);
  const currentPod = api.pods.get(currentName);
  const oldToken = api.secrets.get(oldName)?.stringData["token"];
  const currentToken = api.secrets.get(currentName)?.stringData["token"];
  ran(currentPod, "registry/pipoca@sha256:new");
  ran(oldPod, "registry/pipoca@sha256:old");

  await eventually(
    () =>
      api.pods.has(oldName) &&
      api.pods.get(oldName) !== oldPod &&
      api.secrets.get(oldName)?.stringData["token"] !== undefined &&
      api.secrets.get(oldName)?.stringData["token"] !== oldToken,
  );

  await sleep(200);

  expect(oldPod?.spec["initContainers"]).toMatchObject([
    { image: "pipoca:test" },
  ]);

  expect([...api.claims.keys()].sort()).toEqual([oldName, currentName].sort());
  expect(api.pods.get(currentName)).toBe(currentPod);
  expect(api.secrets.get(currentName)?.stringData["token"]).toBe(currentToken);
  expect(api.pods.get(oldName)?.spec["terminationGracePeriodSeconds"]).toBe(30);

  expect(
    logs.filter((line) => line.includes("runner pod replaced")),
  ).toHaveLength(1);
});
