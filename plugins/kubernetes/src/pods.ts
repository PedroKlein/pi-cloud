import { isObject } from "@pipoca/plugins";
import { environmentLabel, sessionLabel } from "./cluster";
import type { KubernetesSettings } from "./settings";

export interface PodOptions {
  readonly name: string;
  readonly environmentId: string;
  // The Environment's image, which the agent and its Sessions run in.
  readonly image: string;
  // The Pipoca image, which the binary is copied from.
  readonly binaryImage: string;
  readonly binaryPullPolicy: string | undefined;
  // The server's in-cluster address.
  readonly server: string;
  // Added to the agent's own environment.
  readonly variables: Readonly<Record<string, string>>;
  readonly settings: KubernetesSettings;
  // A pod started for one Session keeps its home, and so the Session's
  // workspace, on the Session's claim.
  readonly sessionId?: string;
}

const binaryDir = "/pipoca";
const home = "/home/pi";

// A runner pod: an init container copies the pipoca binary in, and the
// agent joins with its token from the pod's Secret of the same name. Sessions
// in it use process isolation (ADR 0032). The pod joins the namespace's
// Istio mesh, if any, as the server does: a mesh with strict mTLS turns away
// a pod without the sidecar, and Istio's native sidecar stops with the agent.
export function runnerPod(options: PodOptions): object {
  const { name, settings } = options;

  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      labels: {
        "app.kubernetes.io/managed-by": "pipoca",
        [environmentLabel]: options.environmentId,
        ...(options.sessionId !== undefined && {
          [sessionLabel]: options.sessionId,
        }),
      },
    },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      // A new volume is root's. The Pipoca image and most images built on
      // node run as uid and gid 1000, as the server does.
      securityContext: { fsGroup: 1000 },
      volumes: [
        { name: "pipoca", emptyDir: {} },
        options.sessionId === undefined
          ? { name: "home", emptyDir: {} }
          : { name: "home", persistentVolumeClaim: { claimName: name } },
      ],
      initContainers: [
        {
          name: "pipoca",
          image: options.binaryImage,
          ...(options.binaryPullPolicy !== undefined && {
            imagePullPolicy: options.binaryPullPolicy,
          }),
          command: ["cp", "/usr/local/bin/pipoca", `${binaryDir}/pipoca`],
          volumeMounts: [{ name: "pipoca", mountPath: binaryDir }],
        },
      ],
      containers: [
        {
          name: "runner",
          image: options.image,
          // A failed agent's last log lines show where it stopped.
          terminationMessagePolicy: "FallbackToLogsOnError",
          command: [
            `${binaryDir}/pipoca`,
            "agent",
            "--name",
            name,
            "--server",
            options.server,
            "--capacity",
            options.sessionId === undefined ? String(settings.capacity) : "1",
            "--exit-when-idle",
            String(settings.idleSeconds),
            ...(options.sessionId === undefined
              ? []
              : ["--session", options.sessionId]),
          ],
          env: [
            { name: "HOME", value: home },
            ...Object.entries(options.variables).map(([key, value]) => ({
              name: key,
              value,
            })),
            {
              name: "PIPOCA_TOKEN",
              valueFrom: { secretKeyRef: { name, key: "token" } },
            },
          ],
          volumeMounts: [
            { name: "pipoca", mountPath: binaryDir },
            { name: "home", mountPath: home },
          ],
        },
      ],
    },
  };

  // A patch must not hand the pod a service account token: the server's own
  // lives in this namespace and can read every runner's Secret.
  return mergePatch(mergePatch(pod, settings.podPatch), {
    spec: {
      automountServiceAccountToken: false,
      serviceAccountName: null,
      serviceAccount: null,
    },
  }) as object;
}

// The pod named after a Session, so a replacement takes the Session back.
export function sessionPodName(sessionId: string): string {
  return `pi-session-${sessionId}`;
}

export function sessionClaim(
  sessionId: string,
  environmentId: string,
  { claimSize, storageClass }: KubernetesSettings,
): object {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: sessionPodName(sessionId),
      labels: {
        "app.kubernetes.io/managed-by": "pipoca",
        [environmentLabel]: environmentId,
        [sessionLabel]: sessionId,
      },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: claimSize } },
      ...(storageClass !== null && { storageClassName: storageClass }),
    },
  };
}

// RFC 7386.
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) {
    return patch;
  }

  const merged = new Map(Object.entries(isObject(target) ? target : {}));

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      merged.delete(key);
    } else {
      merged.set(key, mergePatch(merged.get(key), value));
    }
  }

  return Object.fromEntries(merged);
}
