import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RunnerPod {
  readonly name: string;
  readonly environmentId: string;
  // Set on a pod started for one Session, which mounts its claim.
  readonly sessionId: string | undefined;
  readonly phase: string;
  readonly createdAt: number;
  // Why a container of the pod failed or can't start, such as its last log
  // lines or an image that can't be pulled.
  readonly problem: string | undefined;
  // The Pipoca image its init container copied the binary from, and the
  // image ID the node ran it as, once known.
  readonly binaryImage: string | undefined;
  readonly binaryImageId: string | undefined;
  readonly deleting: boolean;
}

interface ContainerStatus {
  readonly name: string;
  readonly image?: string;
  readonly imageID?: string;
  readonly state?: {
    readonly waiting?: { readonly reason?: string; readonly message?: string };
    readonly terminated?: {
      readonly exitCode: number;
      readonly reason?: string;
      readonly message?: string;
    };
  };
}

// Normal while a pod starts.
const starting = new Set(["ContainerCreating", "PodInitializing"]);

// The calls the plugin makes in the server's own namespace.
export interface Cluster {
  // The runner pods of every Environment.
  readonly runnerPods: () => Promise<readonly RunnerPod[]>;
  readonly createSecret: (
    name: string,
    environmentId: string,
    data: Record<string, string>,
  ) => Promise<void>;
  readonly createPod: (pod: object) => Promise<void>;
  readonly deletePod: (name: string) => Promise<void>;
  // The ID a pod's node ran an image as, such as the server's own.
  readonly imageId: (pod: string, image: string) => Promise<string | undefined>;
  readonly deleteSecret: (name: string) => Promise<void>;
  // The Secrets of runner pods, by Environment.
  readonly runnerSecrets: () => Promise<
    readonly { readonly name: string; readonly environmentId: string }[]
  >;
  // The claims of Sessions' own workspaces, by Session.
  readonly sessionClaims: () => Promise<
    readonly { readonly name: string; readonly sessionId: string }[]
  >;
  // A claim that already exists is kept.
  readonly createClaim: (claim: object) => Promise<void>;
  readonly deleteClaim: (name: string) => Promise<void>;
}

export interface ApiAccess {
  readonly url: string;
  readonly namespace: string;
  readonly token: () => string;
  readonly ca?: string;
}

export const environmentLabel = "pipoca.dev/environment";
export const sessionLabel = "pipoca.dev/session";

const serviceAccount = "/var/run/secrets/kubernetes.io/serviceaccount";

// The server reaches the API with its pod's service account, so no kubeconfig
// is stored (ADR 0032). Outside a cluster there is none.
export function inClusterApi(dir = serviceAccount): ApiAccess | undefined {
  const host = process.env["KUBERNETES_SERVICE_HOST"];
  const port = process.env["KUBERNETES_SERVICE_PORT"] ?? "443";

  let namespace: string;
  let ca: string;
  try {
    namespace = readFileSync(join(dir, "namespace"), "utf8").trim();
    ca = readFileSync(join(dir, "ca.crt"), "utf8");
  } catch {
    return undefined;
  }

  if (host === undefined) {
    return undefined;
  }

  return {
    url: `https://${host.includes(":") ? `[${host}]` : host}:${port}`,
    namespace,
    // The kubelet rotates the token in place.
    token: () => readFileSync(join(dir, "token"), "utf8").trim(),
    ca,
  };
}

export function clusterAt(options: ApiAccess): Cluster {
  const base = `${options.url}/api/v1/namespaces/${options.namespace}`;

  const call = async (
    method: string,
    path: string,
    body?: object,
  ): Promise<unknown> => {
    const response = await fetch(`${base}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token()}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(options.ca !== undefined && { tls: { ca: options.ca } }),
    });

    if (
      (method === "DELETE" && response.status === 404) ||
      (path === "persistentvolumeclaims" && response.status === 409)
    ) {
      return undefined;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `${method} ${path} returned ${String(response.status)}: ${text.slice(0, 300)}`,
      );
    }

    return response.json();
  };

  return {
    runnerPods: async () => {
      const list = (await call(
        "GET",
        `pods?labelSelector=${encodeURIComponent(environmentLabel)}`,
      )) as {
        readonly items: readonly {
          readonly metadata: {
            readonly name: string;
            readonly labels?: Readonly<Record<string, string>>;
            readonly creationTimestamp?: string;
            readonly deletionTimestamp?: string;
          };
          readonly spec?: {
            readonly initContainers?: readonly {
              readonly name: string;
              readonly image?: string;
            }[];
          };
          readonly status?: {
            readonly phase?: string;
            readonly initContainerStatuses?: readonly ContainerStatus[];
            readonly containerStatuses?: readonly ContainerStatus[];
          };
        }[];
      };

      return list.items.map(({ metadata, spec, status }) => ({
        name: metadata.name,
        environmentId: metadata.labels?.[environmentLabel] ?? "",
        sessionId: metadata.labels?.[sessionLabel],
        phase: status?.phase ?? "Pending",
        createdAt: Date.parse(metadata.creationTimestamp ?? "") || Date.now(),
        problem: [
          ...(status?.initContainerStatuses ?? []),
          ...(status?.containerStatuses ?? []),
        ]
          .map(problemOf)
          .find((problem) => problem !== undefined),
        binaryImage: spec?.initContainers?.find(({ name }) => name === "pipoca")
          ?.image,
        binaryImageId: status?.initContainerStatuses?.find(
          ({ name }) => name === "pipoca",
        )?.imageID,
        deleting: metadata.deletionTimestamp !== undefined,
      }));
    },
    createSecret: async (name, environmentId, data) => {
      await call("POST", "secrets", {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name,
          labels: {
            "app.kubernetes.io/managed-by": "pipoca",
            [environmentLabel]: environmentId,
          },
        },
        stringData: data,
      });
    },
    createPod: async (pod) => {
      await call("POST", "pods", pod);
    },
    deletePod: async (name) => {
      await call("DELETE", `pods/${name}`);
    },
    imageId: async (pod, image) => {
      const { status } = (await call("GET", `pods/${pod}`)) as {
        readonly status?: {
          readonly initContainerStatuses?: readonly ContainerStatus[];
          readonly containerStatuses?: readonly ContainerStatus[];
        };
      };

      return [
        ...(status?.containerStatuses ?? []),
        ...(status?.initContainerStatuses ?? []),
      ].find((each) => each.image === image && each.imageID !== "")?.imageID;
    },
    deleteSecret: async (name) => {
      await call("DELETE", `secrets/${name}`);
    },
    runnerSecrets: async () => {
      const list = (await call(
        "GET",
        `secrets?labelSelector=${encodeURIComponent(environmentLabel)}`,
      )) as {
        readonly items: readonly {
          readonly metadata: {
            readonly name: string;
            readonly labels?: Readonly<Record<string, string>>;
          };
        }[];
      };

      return list.items.map(({ metadata }) => ({
        name: metadata.name,
        environmentId: metadata.labels?.[environmentLabel] ?? "",
      }));
    },
    sessionClaims: async () => {
      const list = (await call(
        "GET",
        `persistentvolumeclaims?labelSelector=${encodeURIComponent(sessionLabel)}`,
      )) as {
        readonly items: readonly {
          readonly metadata: {
            readonly name: string;
            readonly labels?: Readonly<Record<string, string>>;
          };
        }[];
      };

      return list.items.map(({ metadata }) => ({
        name: metadata.name,
        sessionId: metadata.labels?.[sessionLabel] ?? "",
      }));
    },
    createClaim: async (claim) => {
      await call("POST", "persistentvolumeclaims", claim);
    },
    deleteClaim: async (name) => {
      await call("DELETE", `persistentvolumeclaims/${name}`);
    },
  };
}

function problemOf({ name, state }: ContainerStatus): string | undefined {
  const { waiting, terminated } = state ?? {};

  if (terminated !== undefined && terminated.exitCode !== 0) {
    const message = terminated.message?.trim().slice(-600) ?? "";
    const detail = message === "" ? terminated.reason : message;

    return `${name} exited with ${String(terminated.exitCode)}${detail === undefined ? "" : `: ${detail}`}`;
  }

  if (waiting?.reason !== undefined && !starting.has(waiting.reason)) {
    return `${name} is waiting: ${waiting.message ?? waiting.reason}`;
  }

  return undefined;
}
