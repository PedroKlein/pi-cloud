import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  isObject,
  readJson,
  requireAdmin,
  type ServerPlugin,
  type ServerPluginContext,
} from "@pipoca/plugins";
import { type Environment, movable } from "@pipoca/protocol";
import {
  type ApiAccess,
  type Cluster,
  clusterAt,
  type RunnerPod,
  inClusterApi,
} from "./cluster";
import { type FailedPod, PodFailures } from "./failures";
import { runnerPod, sessionClaim, sessionPodName } from "./pods";
import {
  type KubernetesEnvironment,
  type KubernetesSettings,
  type SettingsStore,
  settingsFrom,
  settingsStore,
} from "./settings";

export interface KubernetesOptions {
  readonly api: ApiAccess | undefined;
  // The Pipoca image, and the image of an Environment that names none.
  readonly image: string | undefined;
  // How the cluster pulls that image, as for the server's own pod. A moving
  // tag such as main needs Always, or a node keeps copying an old binary.
  readonly imagePullPolicy?: string | undefined;
  // The server's in-cluster address, which runner pods poll.
  readonly server: string | undefined;
  // The server's own pod. The image ID its node ran tells an old binary from
  // a new one under a moving tag such as main.
  readonly pod?: string | undefined;
  readonly variables?: Readonly<Record<string, string>>;
  readonly intervalMs?: number;
  // How long an Environment waits for a new pod after one fails. It doubles
  // with each failure in a row, up to 32 times as long.
  readonly retryAfterMs?: number;
}

interface Pods {
  readonly cluster: Cluster;
  readonly image: string;
  readonly imagePullPolicy: string | undefined;
  readonly server: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly imageId: () => Promise<string | undefined>;
  // Pods made before the server started may have stopped while it was down.
  readonly since: number;
}

const finished = new Set(["Succeeded", "Failed"]);

// Longer than pulling a large image takes.
const stuckAfterMs = 10 * 60_000;

// Starts runner pods for the Sessions of a Kubernetes Environment that no
// runner can take, and removes the pods that stopped (ADR 0032).
export function kubernetes(options: () => KubernetesOptions): ServerPlugin {
  return {
    name: "kubernetes",
    register: (context) => {
      const store = settingsStore(context.store);

      const {
        api,
        image,
        imagePullPolicy,
        server,
        pod,
        variables = {},
        intervalMs = 2000,
        retryAfterMs = 10_000,
      } = options();

      const failures = new PodFailures(retryAfterMs);

      const startsPods =
        api !== undefined && image !== undefined && server !== undefined;

      const answer = (
        environmentId: string,
        settings: KubernetesSettings | null,
      ): Response =>
        Response.json({
          settings,
          startsPods,
          lastFailure: failures.last(environmentId),
        } satisfies KubernetesEnvironment);

      context.routes.handle(async (request, path, caller) => {
        const [resource, environmentId] = path.split("/");

        const environment = context.environments
          .list()
          .find(({ id }) => id === environmentId);

        if (
          caller.kind !== "user" ||
          resource !== "environments" ||
          environmentId === undefined ||
          environment === undefined
        ) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }

        if (request.method === "GET") {
          return answer(environmentId, store.get(environmentId) ?? null);
        }

        if (request.method !== "POST") {
          return Response.json({ error: "not_found" }, { status: 404 });
        }

        // A pod patch can mount the namespace's Secrets or run privileged,
        // so it is as much as the server's own access (ADR 0038).
        requireAdmin(caller, "only admins change Kubernetes settings");

        const body = await readJson(request);

        if (!isObject(body)) {
          return Response.json(
            { error: "send { settings }, or { settings: null } to stop" },
            { status: 400 },
          );
        }

        if (body["settings"] === null) {
          store.remove(environmentId);
          failures.clearEnvironment(environmentId);
          context.log("kubernetes settings removed", { environmentId });

          return answer(environmentId, null);
        }

        const settings = settingsFrom(body["settings"]);

        if (typeof settings === "string") {
          return Response.json({ error: settings }, { status: 400 });
        }

        if (environment.isolation !== "process") {
          return Response.json(
            { error: "runner pods run Sessions as processes" },
            { status: 409 },
          );
        }

        store.set(environmentId, settings);
        failures.clearEnvironment(environmentId);
        context.log("kubernetes settings saved", { environmentId });

        return answer(environmentId, settings);
      });

      if (startsPods) {
        context.environments.startsRunners(
          (environmentId) => store.get(environmentId) !== undefined,
        );
      }

      if (api === undefined || image === undefined || server === undefined) {
        context.log("kubernetes runner pods off", {
          inCluster: api !== undefined,
          image: image !== undefined,
          server: server !== undefined,
        });

        return;
      }

      const cluster = clusterAt(api);
      let imageId: string | undefined;

      const pods: Pods = {
        cluster,
        image,
        imagePullPolicy,
        server,
        variables,
        imageId: async () => {
          if (imageId === undefined && pod !== undefined) {
            imageId = await cluster.imageId(pod, image).catch(() => undefined);
          }

          return imageId;
        },
        since: Date.now(),
      };

      // The first pass waits a tick: the server finishes starting plugins
      // before their context answers.
      void (async () => {
        while (
          await sleep(intervalMs, undefined, { signal: context.signal }).then(
            () => true,
            () => false,
          )
        ) {
          await reconcile(context, pods, store, failures).catch(
            (error: unknown) => {
              context.log("kubernetes runner pods not reconciled", {
                error: String(error),
              });
            },
          );
        }
      })();
    },
  };
}

export const kubernetesPlugin = kubernetes(() => {
  const faux = process.env["PIPOCA_FAUX_REPLY"];

  return {
    api: inClusterApi(),
    image: process.env["PIPOCA_IMAGE"],
    imagePullPolicy: process.env["PIPOCA_IMAGE_PULL_POLICY"],
    server: process.env["PIPOCA_RUNNER_URL"],
    pod: process.env["POD_NAME"] ?? process.env["HOSTNAME"],
    // Tests run the binary on Pi's faux model, in pods too.
    variables: faux === undefined ? {} : { PIPOCA_FAUX_REPLY: faux },
  };
});

async function reconcile(
  context: ServerPluginContext,
  pods: Pods,
  store: SettingsStore,
  failures: PodFailures,
): Promise<void> {
  const environments = context.environments.list();
  const all = await pods.cluster.runnerPods();
  const imageId = await pods.imageId();
  const now = Date.now();

  // Pods of an Environment without settings run until their agent stops.
  // Pods of an Environment this server doesn't know belong to another server
  // in the namespace.
  const removing: {
    readonly pod: RunnerPod;
    readonly reason: string;
    readonly problem: string | undefined;
  }[] = [];

  const failed: FailedPod[] = [];
  const outdated: RunnerPod[] = [];

  for (const pod of all) {
    const environment = environments.find(({ id }) => id === pod.environmentId);
    const reason = removalReason(pod, now);
    if (environment === undefined) {
      continue;
    }

    if (reason === undefined) {
      if (
        store.get(pod.environmentId) !== undefined &&
        !pod.deleting &&
        !sameBinary(pod, pods.image, imageId)
      ) {
        outdated.push(pod);
      }

      continue;
    }

    const joined =
      pod.createdAt < pods.since ||
      environment.runners.some(({ name }) => name === pod.name);

    const problem = failureOf(pod, reason, joined, pods.server);
    removing.push({ pod, reason, problem });

    if (problem !== undefined) {
      failed.push({
        key: failureKey(pod),
        environmentId: pod.environmentId,
        pod: pod.name,
        problem,
      });
    }
  }

  // Before any delete, so no pod is gone while its failure is unknown.
  failures.record(failed, now);

  const removed = new Set(removing.map(({ pod }) => pod.name));

  for (const { pod, reason, problem } of removing) {
    context.environments.revokeRunner(pod.environmentId, pod.name);

    // One pod the API won't delete holds back no other Environment.
    try {
      await pods.cluster.deletePod(pod.name);
      await pods.cluster.deleteSecret(pod.name);
    } catch (error) {
      context.log("runner pod not removed", {
        environmentId: pod.environmentId,
        pod: pod.name,
        error: String(error),
      });

      continue;
    }

    context.log("runner pod removed", {
      environmentId: pod.environmentId,
      pod: pod.name,
      phase: pod.phase,
      reason,
      ...(problem !== undefined && { problem }),
    });
  }

  // After an upgrade a pod would run the old binary against the new server.
  // Deleting it gracefully lets its agent halt its Sessions first, and once
  // it is gone the pass below revokes its token, as for any pod deleted from
  // outside. A Session's claim stays, so its Session goes on in the new pod.
  for (const pod of outdated) {
    try {
      await pods.cluster.deletePod(pod.name);
    } catch (error) {
      context.log("runner pod not replaced", {
        environmentId: pod.environmentId,
        pod: pod.name,
        error: String(error),
      });

      continue;
    }

    context.log("runner pod replaced", {
      environmentId: pod.environmentId,
      pod: pod.name,
      binaryImage: pod.binaryImage,
      binaryImageId: pod.binaryImageId,
      image: pods.image,
      imageId,
    });
  }

  // A pod deleted from outside leaves its Secret, and its token valid.
  for (const secret of await pods.cluster.runnerSecrets()) {
    const known = environments.some(({ id }) => id === secret.environmentId);
    if (!known || all.some(({ name }) => name === secret.name)) {
      continue;
    }

    context.environments.revokeRunner(secret.environmentId, secret.name);
    await pods.cluster.deleteSecret(secret.name);

    context.log("runner secret removed", {
      environmentId: secret.environmentId,
      secret: secret.name,
    });
  }

  // An archived Session's workspace is removed, as on any runner, so its
  // claim goes once no pod mounts it. A workspace its runner kept, or hasn't
  // checked yet, stays until removed or forced, as on any runner.
  for (const claim of await pods.cluster.sessionClaims()) {
    const mounted = all.some(
      ({ name }) => name === claim.name && !removed.has(name),
    );

    const session = context.sessions.get(claim.sessionId);
    if (
      !mounted &&
      session !== undefined &&
      session.archivedAt !== null &&
      session.workspaceRemoval !== "kept" &&
      session.workspaceRemoval !== "pending"
    ) {
      try {
        await pods.cluster.deleteClaim(claim.name);
      } catch (error) {
        context.log("session claim not removed", {
          sessionId: claim.sessionId,
          claim: claim.name,
          error: String(error),
        });

        continue;
      }

      context.log("session claim removed", {
        sessionId: claim.sessionId,
        claim: claim.name,
      });
    }
  }

  for (const [environmentId, settings] of store.all()) {
    const environment = environments.find(({ id }) => id === environmentId);
    if (environment === undefined) {
      continue;
    }

    const active = all.filter(
      (pod) => pod.environmentId === environmentId && !finished.has(pod.phase),
    );

    for (const pod of active) {
      const online = environment.runners.some(
        (runner) => runner.online && runner.name === pod.name,
      );

      if (online && !removed.has(pod.name)) {
        failures.clear(failureKey(pod));
      }
    }

    const waiting = (key: string): boolean => failures.waiting(key, now);

    await scale(context, pods, environment, settings, active, waiting).catch(
      (error: unknown) => {
        context.log("kubernetes runner pods not started", {
          environmentId,
          error: String(error),
        });
      },
    );
  }
}

async function scale(
  context: ServerPluginContext,
  pods: Pods,
  environment: Environment,
  settings: KubernetesSettings,
  active: readonly RunnerPod[],
  waiting: (key: string) => boolean,
): Promise<void> {
  const environmentId = environment.id;

  // The agent in a pod runs Sessions as processes; it has no Docker.
  if (environment.isolation !== "process") {
    return;
  }

  if (settings.workspace === "claim") {
    await scaleSessions(context, pods, environment, settings, active, waiting);

    return;
  }

  if (waiting(environmentId)) {
    return;
  }

  const online = new Set(
    environment.runners.filter((r) => r.online).map(({ name }) => name),
  );

  // A pod that hasn't polled yet takes Sessions once it does. A Session held
  // by a runner that went away moves to a pod only if its Workspace can be
  // made again there.
  const joining = active.filter(({ name }) => !online.has(name)).length;

  const unplaced = context.environments
    .unplaced(environmentId)
    .filter(
      (session) => session.runner === null || movable(session.workspace),
    ).length;

  const wanted = Math.ceil(
    Math.max(0, unplaced - joining * settings.capacity) / settings.capacity,
  );

  const starting = Math.min(wanted, settings.maxPods - active.length);

  for (let i = 0; i < starting; i++) {
    const name = `pi-runner-${randomBytes(4).toString("hex")}`;
    await startPod(context, pods, environment, settings, name);
    context.log("runner pod started", { environmentId, pod: name, unplaced });
  }
}

// A Session's own pod takes only that Session, and a pod of that name, on the
// same claim, takes it back after the pod stops or is deleted (ADR 0032).
async function scaleSessions(
  context: ServerPluginContext,
  pods: Pods,
  environment: Environment,
  settings: KubernetesSettings,
  active: readonly RunnerPod[],
  waiting: (key: string) => boolean,
): Promise<void> {
  const running = new Set(active.map(({ name }) => name));
  let room = settings.maxPods - active.length;

  for (const session of context.environments.unplaced(environment.id)) {
    const name = sessionPodName(session.id);
    if (running.has(name) || room <= 0 || waiting(name)) {
      continue;
    }

    await pods.cluster.createClaim(
      sessionClaim(session.id, environment.id, settings),
    );

    await startPod(context, pods, environment, settings, name, session.id);
    room--;

    context.log("session pod started", {
      environmentId: environment.id,
      sessionId: session.id,
      pod: name,
    });
  }
}

async function startPod(
  context: ServerPluginContext,
  { cluster, image, imagePullPolicy, server, variables }: Pods,
  environment: Environment,
  settings: KubernetesSettings,
  name: string,
  sessionId?: string,
): Promise<void> {
  // A pod deleted from outside leaves its Secret behind.
  await cluster.deleteSecret(name);

  await cluster.createSecret(name, environment.id, {
    token: context.environments.runnerToken(environment.id, name),
  });

  try {
    await cluster.createPod(
      runnerPod({
        name,
        environmentId: environment.id,
        image: environment.image ?? image,
        binaryImage: image,
        binaryPullPolicy: imagePullPolicy,
        server,
        variables,
        settings,
        ...(sessionId !== undefined && { sessionId }),
      }),
    );
  } catch (error) {
    context.environments.revokeRunner(environment.id, name);
    await cluster.deleteSecret(name);
    throw error;
  }
}

// A Session's own pod backs off alone; an Environment's shared pods together.
function failureKey(pod: RunnerPod): string {
  return pod.sessionId === undefined ? pod.environmentId : pod.name;
}

// A pod that stopped before its agent ever polled failed as surely as one
// whose agent crashed: the server never got a runner out of it.
function failureOf(
  pod: RunnerPod,
  reason: string,
  joined: boolean,
  server: string,
): string | undefined {
  if (reason === "never started") {
    return pod.problem ?? "it didn't start in 10 minutes";
  }

  if (pod.phase === "Failed") {
    return pod.problem ?? "its agent failed";
  }

  return joined ? undefined : `its agent never reached the server at ${server}`;
}

// The digests the nodes ran decide. Until both are known, as for a pod
// still pending or a server outside a pod, the names in the specs do.
function sameBinary(
  pod: RunnerPod,
  image: string,
  imageId: string | undefined,
): boolean {
  if (pod.binaryImage === undefined) {
    return true;
  }

  const ran = digestOf(pod.binaryImageId);
  const runs = digestOf(imageId);
  if (ran !== undefined && runs !== undefined) {
    return ran === runs;
  }

  const named = digestOf(pod.binaryImage);
  const names = digestOf(image);

  return named !== undefined && names !== undefined
    ? named === names
    : pod.binaryImage === image;
}

// An image ID such as repo@sha256:..., with a runtime's prefix or none.
function digestOf(image: string | undefined): string | undefined {
  const digest = image?.slice(image.lastIndexOf("@") + 1);

  return digest?.startsWith("sha256:") === true ? digest : undefined;
}

function removalReason(pod: RunnerPod, now: number): string | undefined {
  if (finished.has(pod.phase)) {
    return "stopped";
  }

  if (pod.phase !== "Running" && now - pod.createdAt > stuckAfterMs) {
    return "never started";
  }

  return undefined;
}
