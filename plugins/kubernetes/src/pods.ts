import { environmentLabel, sessionLabel } from "./cluster";
import { isObject, type KubernetesSettings } from "./settings";

export interface PodOptions {
  readonly name: string;
  readonly environmentId: string;
  // The Environment's image, which the agent and its Sessions run in.
  readonly image: string;
  // The Pi Cloud image, which the binary is copied from.
  readonly binaryImage: string;
  // The server's in-cluster address.
  readonly server: string;
  // Added to the agent's own environment.
  readonly variables: Readonly<Record<string, string>>;
  readonly settings: KubernetesSettings;
  // A pod started for one Session keeps its home, and so the Session's
  // workspace, on the Session's claim.
  readonly sessionId?: string;
}

const binaryDir = "/pi-cloud";
const home = "/home/pi";

// A runner pod: an init container copies the pi-cloud binary in, and the
// agent joins with its token from the pod's Secret of the same name. Sessions
// in it use process isolation (ADR 0032).
export function runnerPod(options: PodOptions): object {
  const { name, settings } = options;

  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      labels: {
        "app.kubernetes.io/managed-by": "pi-cloud",
        [environmentLabel]: options.environmentId,
        ...(options.sessionId !== undefined && {
          [sessionLabel]: options.sessionId,
        }),
        // A sidecar would keep the pod running after the agent exits.
        "sidecar.istio.io/inject": "false",
      },
    },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      volumes: [
        { name: "pi-cloud", emptyDir: {} },
        options.sessionId === undefined
          ? { name: "home", emptyDir: {} }
          : { name: "home", persistentVolumeClaim: { claimName: name } },
      ],
      initContainers: [
        {
          name: "pi-cloud",
          image: options.binaryImage,
          command: ["cp", "/usr/local/bin/pi-cloud", `${binaryDir}/pi-cloud`],
          volumeMounts: [{ name: "pi-cloud", mountPath: binaryDir }],
        },
      ],
      containers: [
        {
          name: "runner",
          image: options.image,
          command: [
            `${binaryDir}/pi-cloud`,
            "agent",
            "--name",
            name,
            "--server",
            options.server,
            "--capacity",
            options.sessionId === undefined ? String(settings.capacity) : "1",
            "--exit-when-idle",
            String(settings.idleSeconds),
          ],
          env: [
            { name: "HOME", value: home },
            ...Object.entries(options.variables).map(([key, value]) => ({
              name: key,
              value,
            })),
            {
              name: "PI_CLOUD_TOKEN",
              valueFrom: { secretKeyRef: { name, key: "token" } },
            },
          ],
          volumeMounts: [
            { name: "pi-cloud", mountPath: binaryDir },
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
        "app.kubernetes.io/managed-by": "pi-cloud",
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
