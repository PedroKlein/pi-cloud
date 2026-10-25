import type { PluginStore } from "@pi-cloud/plugins";

// A Kubernetes Environment's runner pods (ADR 0032). The patch is a JSON
// merge patch on the pod, so a list in it, such as containers, replaces the
// whole list.
export interface KubernetesSettings {
  readonly capacity: number;
  readonly maxPods: number;
  readonly idleSeconds: number;
  readonly podPatch: Readonly<Record<string, unknown>>;
}

export const defaultSettings: KubernetesSettings = {
  capacity: 1,
  maxPods: 5,
  idleSeconds: 300,
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

  return {
    capacity: settings.capacity,
    maxPods: settings.maxPods,
    idleSeconds: settings.idleSeconds,
    podPatch: settings.podPatch,
  };
}

interface SettingsStore {
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
