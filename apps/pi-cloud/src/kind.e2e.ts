import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import type { Environment, Session, SessionEvent } from "@pi-cloud/protocol";
import { readSse } from "./sse";
import { setupTokenOf } from "./testdata/sign-in";

// Runs against the Helm chart installed in the current kubectl context, as
// CI does on kind. The agent runs in a pod of the same image, on Pi's faux
// model.
const release = process.env["PI_CLOUD_RELEASE"] ?? "pi-cloud";
const image = process.env["PI_CLOUD_IMAGE"] ?? "pi-cloud:ci";
const server = new URL("http://127.0.0.1:17420");
const agentPod = "kind-agent";

let forward: ChildProcess | undefined;
let cookie = "";

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

afterAll(() => {
  kubectl("delete", "pod", agentPod, "--ignore-not-found", "--wait=false");
  forward?.kill();
});

test("offers the sign-in the chart's config value seeded into pi-cloud.json", async () => {
  const status = (await (await api("/api/auth")).json()) as {
    logins: unknown;
  };

  expect(status.logins).toEqual([
    { label: "Sign in with kind", path: "/api/plugins/oidc/start/kind" },
  ]);
});

test("runs a Session from an agent pod that joined with its Environment's key", async () => {
  const { environment, key } = (await (
    await api("/api/environments", { name: "kind" })
  ).json()) as { environment: Environment; key: string };

  kubectl(
    "run",
    agentPod,
    `--image=${image}`,
    "--image-pull-policy=Never",
    "--restart=Never",
    `--env=PI_CLOUD_KEY=${key}`,
    "--env=PI_CLOUD_FAUX_REPLY=hello from kind",
    "--command",
    "--",
    "pi-cloud",
    "agent",
    `--name=${agentPod}`,
    `--server=http://${release}:7420`,
    "--folder=/data",
  );

  const session = (await (
    await api("/api/sessions", {
      environment: environment.id,
      workspace: { kind: "folder", path: "/data" },
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

test("runs a Session in a runner pod the kubernetes plugin starts, and removes the pod once idle", async () => {
  const { environment } = (await (
    await api("/api/environments", { name: "pods" })
  ).json()) as { environment: Environment };

  const saved = await fetch(
    new URL(`/api/plugins/kubernetes/environments/${environment.id}`, server),
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        settings: { capacity: 1, maxPods: 2, idleSeconds: 5 },
      }),
    },
  );

  expect(saved.status).toBe(200);

  const session = (await (
    await api("/api/sessions", {
      environment: environment.id,
      workspace: {
        kind: "clone",
        repository: "https://github.com/octocat/Hello-World.git",
      },
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

  await api(`/api/sessions/${session.id}/archive`, {});

  const selector = `pi-cloud.dev/environment=${environment.id}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (kubectl("get", "pods", "-l", selector, "-o", "name").trim() === "") {
      return;
    }

    await Bun.sleep(1000);
  }

  throw new Error("the runner pod was never removed");
}, 240_000);

test("brings back a Session's own pod, with its claim, after the pod is deleted", async () => {
  const { environment } = (await (
    await api("/api/environments", { name: "claims" })
  ).json()) as { environment: Environment };

  const saved = await fetch(
    new URL(`/api/plugins/kubernetes/environments/${environment.id}`, server),
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        settings: { workspace: "claim", claimSize: "1Gi", idleSeconds: 5 },
      }),
    },
  );

  expect(saved.status).toBe(200);

  const session = (await (
    await api("/api/sessions", {
      environment: environment.id,
      workspace: {
        kind: "clone",
        repository: "https://github.com/octocat/Hello-World.git",
      },
    })
  ).json()) as Session;

  const pod = `pi-session-${session.id}`;

  const current = async (): Promise<Session> =>
    (await (await api(`/api/sessions/${session.id}`)).json()) as Session;

  const runningAgain = async (generation: number): Promise<Session> => {
    for (let attempt = 0; attempt < 180; attempt++) {
      const now = await current();
      if (now.online && now.status === "idle" && now.generation > generation) {
        return now;
      }

      await Bun.sleep(1000);
    }

    throw new Error("the Session never ran again");
  };

  const first = await runningAgain(0);
  kubectl("delete", "pod", pod, "--wait=true");
  const second = await runningAgain(first.generation);

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

  expect(second.runner).toBe(pod);

  expect(kubectl("get", "pvc", pod, "-o", "name").trim()).toBe(
    `persistentvolumeclaim/${pod}`,
  );

  await api(`/api/sessions/${session.id}/archive`, {});

  for (let attempt = 0; attempt < 120; attempt++) {
    const left = kubectl(
      "get",
      "pods,pvc",
      "-l",
      `pi-cloud.dev/session=${session.id}`,
      "-o",
      "name",
    ).trim();

    if (left === "") {
      return;
    }

    await Bun.sleep(1000);
  }

  throw new Error("the Session's pod and claim were never removed");
}, 360_000);

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
