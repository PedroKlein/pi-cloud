import type { PluginStore } from "@pipoca/plugins";

// A Kubernetes Environment's runner pods (ADR 0032). With "claim", each
// Session gets a pod of its own that mounts a claim of claimSize, so its
// workspace outlives the pod; capacity doesn't apply. The patch is a JSON
// merge patch on the pod, so a list in it, such as containers, replaces the
// whole list.
const workspaces = ["pod", "claim"] as const;

export interface KubernetesSettings {
  readonly workspace: (typeof workspaces)[number];
  readonly capacity: number;
  readonly maxPods: number;
  readonly idleSeconds: number;
  readonly claimSize: string;
  readonly storageClass: string | null;
  readonly podPatch: Readonly<Record<string, unknown>>;
}

// What the plugin's route answers for an Environment. Without settings it
// starts no pods there; outside a cluster it starts none anywhere.
export interface KubernetesEnvironment {
  readonly settings: KubernetesSettings | null;
  readonly startsPods: boolean;
  readonly lastFailure: PodFailure | null;
}

// The last runner pod of an Environment that failed, while no pod since has
// joined. The next pod waits until retryAt.
export interface PodFailure {
  readonly pod: string;
  readonly problem: string;
  readonly at: string;
  readonly retryAt: string;
}

export const defaultSettings: KubernetesSettings = {
  workspace: "pod",
  capacity: 1,
  maxPods: 5,
  idleSeconds: 300,
  claimSize: "10Gi",
  storageClass: null,
  podPatch: {},
};

export function settingsFrom(body: unknown): KubernetesSettings | string {
  if (!isObject(body)) {
    return "settings must be an object";
  }

  const settings = { ...defaultSettings, ...body };

  for (const field of ["capacity", "maxPods", "idleSeconds"] as const) {
    const value = settings[field];
    if (!(Number.isSafeInteger(value) && value > 0)) {
      return `${field} must be a positive integer`;
    }
  }

  if (!isObject(settings.podPatch)) {
    return "podPatch must be an object";
  }

  if (!workspaces.some((workspace) => workspace === settings.workspace)) {
    return 'workspace must be "pod" or "claim"';
  }

  if (
    typeof settings.claimSize !== "string" ||
    !/^\d+(Ki|Mi|Gi|Ti)$/.test(settings.claimSize)
  ) {
    return "claimSize must be a size such as 10Gi";
  }

  if (
    settings.storageClass !== null &&
    typeof settings.storageClass !== "string"
  ) {
    return "storageClass must be a name or null";
  }

  return {
    workspace: settings.workspace,
    capacity: settings.capacity,
    maxPods: settings.maxPods,
    idleSeconds: settings.idleSeconds,
    claimSize: settings.claimSize,
    storageClass: settings.storageClass,
    podPatch: settings.podPatch,
  };
}

export interface SettingsStore {
  readonly get: (environmentId: string) => KubernetesSettings | undefined;
  readonly all: () => readonly (readonly [string, KubernetesSettings])[];
  readonly set: (environmentId: string, settings: KubernetesSettings) => void;
  readonly remove: (environmentId: string) => void;
}

export function settingsStore(store: PluginStore): SettingsStore {
  store.exec(`create table if not exists kubernetes_environments (
    environment_id text primary key,
    settings text not null
  )`);

  const parsed = (row: { environment_id: string; settings: string }) =>
    [
      row.environment_id,
      { ...defaultSettings, ...(JSON.parse(row.settings) as object) },
    ] as const;

  return {
    get: (environmentId) => {
      const rows = store.all(
        "select environment_id, settings from kubernetes_environments where environment_id = ?",
        environmentId,
      ) as { environment_id: string; settings: string }[];

      return rows.map(parsed)[0]?.[1];
    },
    all: () =>
      (
        store.all(
          "select environment_id, settings from kubernetes_environments",
        ) as { environment_id: string; settings: string }[]
      ).map(parsed),
    set: (environmentId, settings) => {
      store.run(
        `insert into kubernetes_environments (environment_id, settings)
         values (?, ?)
         on conflict (environment_id) do update set settings = excluded.settings`,
        environmentId,
        JSON.stringify(settings),
      );
    },
    remove: (environmentId) => {
      store.run(
        "delete from kubernetes_environments where environment_id = ?",
        environmentId,
      );
    },
  };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
