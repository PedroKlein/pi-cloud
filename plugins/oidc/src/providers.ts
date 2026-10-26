import type { PluginConfig, PluginStore } from "@pi-cloud/plugins";
import type { ProviderInput, ProviderView } from "./model";

// A provider as the plugin uses it. Lists are lower case.
export interface ProviderConfig {
  readonly id: string;
  readonly label: string;
  readonly issuer: string;
  readonly clientId: string;
  // Undefined for a public client, which PKCE alone protects.
  readonly clientSecret: string | undefined;
  readonly clientSecretEnv: string | undefined;
  readonly groupsClaim: string;
  readonly accessGroup: string;
  readonly adminGroup: string;
  readonly allowedEmails: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly adminEmails: readonly string[];
}

export class InvalidProvider extends Error {}

export interface ProviderStore {
  readonly list: () => readonly ProviderConfig[];
  readonly get: (id: string) => ProviderConfig | undefined;
  readonly create: (input: unknown) => ProviderConfig;
  // An empty or missing client secret keeps the one the provider has, and
  // null takes it away.
  readonly update: (id: string, input: unknown) => ProviderConfig | undefined;
  readonly remove: (id: string) => boolean;
}

// A provider and its client secret as the file holds it, sealed, so a save
// that keeps the secret writes the same text back.
interface Entry {
  readonly provider: ProviderConfig;
  readonly sealed: string | undefined;
}

const defaultGroupsClaim = "groups";
const defaultLabel = "Sign in with single sign-on";

// The providers live under the plugin's key in pi-cloud.json, which Settings
// and people both edit (ADR 0039). A list that stops fitting is logged, and
// the last one that fit stays in use.
export function providerStore(
  config: PluginConfig,
  store: PluginStore,
  env: NodeJS.ProcessEnv,
  log: (message: string, fields?: Readonly<Record<string, unknown>>) => void,
): ProviderStore {
  // Sessions the server starts inherit its environment, so a secret leaves
  // it once read.
  const fromEnv = new Map<string, string>();

  const secretIn = (name: string): string | undefined => {
    const value = fromEnv.get(name) ?? env[name];

    if (value !== undefined && value !== "") {
      fromEnv.set(name, value);
      Reflect.deleteProperty(env, name);
    }

    return fromEnv.get(name);
  };

  const parse = (value: unknown): readonly Entry[] =>
    entriesOf(value, (sealed, id) => store.open(sealed, id), secretIn);

  moveTable(config, store);

  let read = JSON.stringify(config.get());
  let entries = parse(config.get());

  const current = (): readonly Entry[] => {
    const value = config.get();
    const text = JSON.stringify(value);

    if (text !== read) {
      read = text;

      try {
        entries = parse(value);
      } catch (failure) {
        log("providers in the config file don't fit", {
          error: failure instanceof Error ? failure.message : String(failure),
        });
      }
    }

    return entries;
  };

  const save = (next: readonly Entry[]): void => {
    const value = config.get();

    try {
      config.set({
        ...(isObject(value) ? value : {}),
        providers: next.map(fileEntry),
      });
    } catch (failure) {
      throw new InvalidProvider(
        failure instanceof Error ? failure.message : String(failure),
      );
    }

    entries = next;
    read = JSON.stringify(config.get());
  };

  const get = (id: string): Entry | undefined =>
    current().find(({ provider }) => provider.id === id);

  const changed = (
    id: string,
    input: unknown,
    before: Entry | undefined,
  ): Entry => {
    const fields = fieldsOf(input);
    const secret = fields.clientSecret;

    if (secret !== undefined && secret !== null && typeof secret !== "string") {
      throw new InvalidProvider("clientSecret must be text");
    }

    const provider = providerFrom(id, fields);

    if (secret === null) {
      return { provider, sealed: undefined };
    }

    if (secret !== undefined && secret.trim() !== "") {
      return {
        provider: { ...provider, clientSecret: secret.trim() },
        sealed: store.seal(secret.trim(), id),
      };
    }

    return {
      provider: {
        ...provider,
        clientSecret: before?.provider.clientSecret,
        clientSecretEnv: before?.provider.clientSecretEnv,
      },
      sealed: before?.sealed,
    };
  };

  return {
    list: () => current().map(({ provider }) => provider),
    get: (id) => get(id)?.provider,
    create: (input) => {
      const taken = new Set(current().map(({ provider }) => provider.id));

      const entry = changed(
        freeId(fieldsOf(input).label, taken),
        input,
        undefined,
      );

      save([...current(), entry]);

      return entry.provider;
    },
    update: (id, input) => {
      const before = get(id);
      if (before === undefined) {
        return undefined;
      }

      const entry = changed(id, input, before);
      save(current().map((each) => (each === before ? entry : each)));

      return entry.provider;
    },
    remove: (id) => {
      const before = get(id);
      if (before === undefined) {
        return false;
      }

      save(current().filter((each) => each !== before));

      return true;
    },
  };
}

// The web never gets a client secret back, only whether one is set.
export function viewOf({
  clientSecret,
  clientSecretEnv,
  ...provider
}: ProviderConfig): ProviderView {
  return {
    ...provider,
    hasClientSecret: clientSecret !== undefined,
    clientSecretEnv: clientSecretEnv ?? null,
  };
}

function entriesOf(
  value: unknown,
  open: (sealed: string, id: string) => string,
  secretIn: (name: string) => string | undefined,
): readonly Entry[] {
  if (value === undefined) {
    return [];
  }

  if (!isObject(value)) {
    throw new InvalidProvider("oidc in pi-cloud.json must be an object");
  }

  const { providers = [] } = value;

  if (!Array.isArray(providers)) {
    throw new InvalidProvider("oidc.providers must be a list");
  }

  const ids = new Set<string>();

  return providers.map((item: unknown, index): Entry => {
    const where = `oidc.providers[${String(index)}]`;

    try {
      if (!isObject(item)) {
        throw new InvalidProvider("must be an object");
      }

      const { id, clientSecret, clientSecretEnv } = item;

      if (typeof id !== "string" || !/^[\w-]+$/.test(id)) {
        throw new InvalidProvider("id must be letters, digits, - or _");
      }

      if (ids.has(id)) {
        throw new InvalidProvider(`id ${id} is used twice`);
      }

      ids.add(id);

      const provider = providerFrom(id, item);

      if (clientSecretEnv !== undefined) {
        const secret =
          typeof clientSecretEnv === "string"
            ? secretIn(clientSecretEnv)
            : undefined;

        if (typeof clientSecretEnv !== "string" || secret === undefined) {
          throw new InvalidProvider(
            "clientSecretEnv names no environment variable that is set",
          );
        }

        return {
          provider: { ...provider, clientSecret: secret, clientSecretEnv },
          sealed: undefined,
        };
      }

      if (clientSecret === undefined) {
        return { provider, sealed: undefined };
      }

      if (typeof clientSecret !== "string") {
        throw new InvalidProvider("clientSecret must be text");
      }

      return {
        provider: { ...provider, clientSecret: opened(clientSecret, id, open) },
        sealed: clientSecret,
      };
    } catch (failure) {
      if (failure instanceof InvalidProvider) {
        throw new InvalidProvider(`${where}: ${failure.message}`);
      }

      throw failure;
    }
  });
}

function opened(
  sealed: string,
  id: string,
  open: (sealed: string, id: string) => string,
): string {
  try {
    return open(sealed, id);
  } catch {
    throw new InvalidProvider(
      "clientSecret must be sealed by Settings; name an environment variable in clientSecretEnv instead",
    );
  }
}

// What the file holds for a provider, leaving out what is empty or default.
function fileEntry({ provider, sealed }: Entry): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      id: provider.id,
      label: provider.label === defaultLabel ? "" : provider.label,
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: sealed,
      clientSecretEnv: provider.clientSecretEnv,
      groupsClaim:
        provider.groupsClaim === defaultGroupsClaim ? "" : provider.groupsClaim,
      accessGroup: provider.accessGroup,
      adminGroup: provider.adminGroup,
      allowedEmails: provider.allowedEmails,
      allowedDomains: provider.allowedDomains,
      adminEmails: provider.adminEmails,
    }).filter(
      ([, value]) =>
        value !== undefined &&
        value !== "" &&
        !(Array.isArray(value) && value.length === 0),
    ),
  );
}

// A readable id for the file, such as "sap" for "Sign in with SAP".
function freeId(label: unknown, taken: ReadonlySet<string>): string {
  const base =
    (typeof label === "string" ? label : "")
      .toLowerCase()
      .replace(/^sign in with\s+/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "provider";

  let id = base;
  for (let n = 2; taken.has(id); n++) {
    id = `${base}-${String(n)}`;
  }

  return id;
}

// Providers from before ADR 0039 lived in a table. Their secrets were sealed
// for the same id, so they move over as they are.
function moveTable(config: PluginConfig, store: PluginStore): void {
  const [table] = store.all(
    "select name from sqlite_master where type = 'table' and name = 'oidc_providers'",
  );

  if (table === undefined) {
    return;
  }

  const rows = store.all(
    "select * from oidc_providers order by created_at",
  ) as {
    readonly id: string;
    readonly label: string;
    readonly issuer: string;
    readonly client_id: string;
    readonly client_secret: string | null;
    readonly groups_claim: string;
    readonly access_group: string;
    readonly admin_group: string;
    readonly allowed_emails: string;
    readonly allowed_domains: string;
    readonly admin_emails: string;
  }[];

  if (rows.length > 0) {
    const value = config.get();
    const { providers = [] } = isObject(value) ? value : {};

    config.set({
      ...(isObject(value) ? value : {}),
      providers: [
        ...(Array.isArray(providers) ? (providers as unknown[]) : []),
        ...rows.map((row) => ({
          id: row.id,
          label: row.label,
          issuer: row.issuer,
          clientId: row.client_id,
          ...(row.client_secret !== null && {
            clientSecret: row.client_secret,
          }),
          groupsClaim: row.groups_claim,
          accessGroup: row.access_group,
          adminGroup: row.admin_group,
          allowedEmails: JSON.parse(row.allowed_emails) as unknown,
          allowedDomains: JSON.parse(row.allowed_domains) as unknown,
          adminEmails: JSON.parse(row.admin_emails) as unknown,
        })),
      ],
    });
  }

  store.exec("drop table oidc_providers");
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldsOf(
  input: unknown,
): Partial<Record<keyof ProviderInput, unknown>> {
  return isObject(input) ? input : {};
}

function providerFrom(id: string, input: unknown): ProviderConfig {
  const fields = fieldsOf(input);

  const text = (name: keyof ProviderInput, fallback = ""): string => {
    const value = fields[name] ?? "";

    if (typeof value !== "string") {
      throw new InvalidProvider(`${name} must be text`);
    }

    return value.trim() === "" ? fallback : value.trim();
  };

  const list = (name: keyof ProviderInput): readonly string[] => {
    const value = fields[name] ?? [];

    if (
      !Array.isArray(value) ||
      !value.every((each) => typeof each === "string")
    ) {
      throw new InvalidProvider(`${name} must be a list of text`);
    }

    return value.flatMap((each: string) =>
      each.trim() === "" ? [] : [each.trim().toLowerCase()],
    );
  };

  const issuer = text("issuer");
  const clientId = text("clientId");

  if (!URL.canParse(issuer)) {
    throw new InvalidProvider("issuer must be a URL");
  }

  if (clientId === "") {
    throw new InvalidProvider("clientId is needed");
  }

  return {
    id,
    label: text("label", defaultLabel),
    issuer,
    clientId,
    clientSecret: undefined,
    clientSecretEnv: undefined,
    groupsClaim: text("groupsClaim", defaultGroupsClaim),
    accessGroup: text("accessGroup"),
    adminGroup: text("adminGroup"),
    allowedEmails: list("allowedEmails"),
    allowedDomains: list("allowedDomains"),
    adminEmails: list("adminEmails"),
  };
}
