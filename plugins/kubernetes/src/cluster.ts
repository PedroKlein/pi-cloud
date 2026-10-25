import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RunnerPod {
  readonly name: string;
  readonly phase: string;
}

// The calls the plugin makes in the server's own namespace.
export interface Cluster {
  readonly runnerPods: (environmentId: string) => Promise<readonly RunnerPod[]>;
  readonly createSecret: (
    name: string,
    data: Record<string, string>,
  ) => Promise<void>;
  readonly createPod: (pod: object) => Promise<void>;
  readonly deletePod: (name: string) => Promise<void>;
  readonly deleteSecret: (name: string) => Promise<void>;
}

export interface ApiAccess {
  readonly url: string;
  readonly namespace: string;
  readonly token: () => string;
  readonly ca?: string;
}

export const environmentLabel = "pi-cloud.dev/environment";

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

    if (method === "DELETE" && response.status === 404) {
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
    runnerPods: async (environmentId) => {
      const selector = encodeURIComponent(
        `${environmentLabel}=${environmentId}`,
      );

      const list = (await call("GET", `pods?labelSelector=${selector}`)) as {
        readonly items: readonly {
          readonly metadata: { readonly name: string };
          readonly status?: { readonly phase?: string };
        }[];
      };

      return list.items.map(({ metadata, status }) => ({
        name: metadata.name,
        phase: status?.phase ?? "Pending",
      }));
    },
    createSecret: async (name, data) => {
      await call("POST", "secrets", {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name,
          labels: { "app.kubernetes.io/managed-by": "pi-cloud" },
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
    deleteSecret: async (name) => {
      await call("DELETE", `secrets/${name}`);
    },
  };
}
