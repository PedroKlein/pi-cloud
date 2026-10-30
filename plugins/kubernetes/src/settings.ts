import type { PluginStore } from "@pipoca/plugins";

// A Kubernetes Environment's runner pods (ADR 0032). With "claim", each
// Session gets a pod of its own that mounts a claim of claimSize, so its
// workspace outlives the pod; capacity doesn't apply. The patch is a JSON
// merge patch on the pod, so a list in it, such as containers, replaces the
// whole list.
export const workspaces = ["pod", "claim"] as const;

export interface KubernetesSettings {
  readonly workspace: (typeof workspaces)[number];
  readonly capacity: number;
  readonly maxPods: number;
  readonly idleSeconds: number;
  readonly claimSize: string;
  readonly storageClass: string | null;
  readonly podPatch: Readonly<Record<string, unknown>>;
}

// What the plugin's route answers for an Environment or a template. Without
// settings it starts no pods there; outside a cluster it starts none
// anywhere. An Environment made from a template shows the template's, which
// only admins change, on the template (ADR 0049).
export interface KubernetesEnvironment {
  readonly settings: KubernetesSettings | null;
  readonly startsPods: boolean;
  readonly lastFailure: PodFailure | null;
  readonly editable: boolean;
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

// A setting the change leaves out takes its default.
export function settingsFrom(
  change: Partial<KubernetesSettings>,
): KubernetesSettings | string {
  const settings = { ...defaultSettings, ...change };

  if (!/^\d+(Ki|Mi|Gi|Ti)$/.test(settings.claimSize)) {
    return "claimSize must be a size such as 10Gi";
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
  readonly get: (id: string) => KubernetesSettings | undefined;
  readonly all: () => readonly (readonly [string, KubernetesSettings])[];
  readonly set: (id: string, settings: KubernetesSettings) => void;
  readonly remove: (id: string) => void;
}

// Settings by template, or by an Environment from before templates.
export function settingsStore(
  store: PluginStore,
  of: "environment" | "template",
): SettingsStore {
  const table = `kubernetes_${of}s`;
  const key = `${of}_id`;

  store.exec(`create table if not exists ${table} (
    ${key} text primary key,
    settings text not null
  )`);

  const rows = (where = "", ...values: string[]) =>
    (
      store.all(
        `select ${key} as id, settings from ${table} ${where}`,
        ...values,
      ) as { id: string; settings: string }[]
    ).map(
      (row) =>
        [
          row.id,
          { ...defaultSettings, ...(JSON.parse(row.settings) as object) },
        ] as const,
    );

  return {
    get: (id) => rows(`where ${key} = ?`, id)[0]?.[1],
    all: () => rows(),
    set: (id, settings) => {
      store.run(
        `insert into ${table} (${key}, settings) values (?, ?)
         on conflict (${key}) do update set settings = excluded.settings`,
        id,
        JSON.stringify(settings),
      );
    },
    remove: (id) => {
      store.run(`delete from ${table} where ${key} = ?`, id);
    },
  };
}
