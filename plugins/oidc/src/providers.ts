import { randomUUID } from "node:crypto";
import type { PluginStore } from "@pi-cloud/plugins";
import type { ProviderInput, ProviderView } from "./model";

// A provider as the plugin keeps it. Lists are lower case.
export interface ProviderConfig {
  readonly id: string;
  readonly label: string;
  readonly issuer: string;
  readonly clientId: string;
  // Undefined for a public client, which PKCE alone protects.
  readonly clientSecret: string | undefined;
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

interface Row {
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
}

export function providerStore(store: PluginStore): ProviderStore {
  store.exec(`
    create table if not exists oidc_providers (
      id text primary key,
      label text not null,
      issuer text not null,
      client_id text not null,
      client_secret text,
      groups_claim text not null,
      access_group text not null,
      admin_group text not null,
      allowed_emails text not null,
      allowed_domains text not null,
      admin_emails text not null,
      created_at text not null
    )
  `);

  const configOf = (row: Row): ProviderConfig => ({
    id: row.id,
    label: row.label,
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecret:
      row.client_secret === null
        ? undefined
        : store.open(row.client_secret, row.id),
    groupsClaim: row.groups_claim,
    accessGroup: row.access_group,
    adminGroup: row.admin_group,
    allowedEmails: JSON.parse(row.allowed_emails) as string[],
    allowedDomains: JSON.parse(row.allowed_domains) as string[],
    adminEmails: JSON.parse(row.admin_emails) as string[],
  });

  const get = (id: string): ProviderConfig | undefined => {
    const [row] = store.all(
      "select * from oidc_providers where id = ?",
      id,
    ) as Row[];

    return row && configOf(row);
  };

  const save = (config: ProviderConfig, insert: boolean): void => {
    const values = [
      config.label,
      config.issuer,
      config.clientId,
      config.clientSecret === undefined
        ? null
        : store.seal(config.clientSecret, config.id),
      config.groupsClaim,
      config.accessGroup,
      config.adminGroup,
      JSON.stringify(config.allowedEmails),
      JSON.stringify(config.allowedDomains),
      JSON.stringify(config.adminEmails),
    ] as const;

    if (insert) {
      store.run(
        "insert into oidc_providers (label, issuer, client_id, client_secret, groups_claim, access_group, admin_group, allowed_emails, allowed_domains, admin_emails, id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ...values,
        config.id,
        new Date().toISOString(),
      );

      return;
    }

    store.run(
      "update oidc_providers set label = ?, issuer = ?, client_id = ?, client_secret = ?, groups_claim = ?, access_group = ?, admin_group = ?, allowed_emails = ?, allowed_domains = ?, admin_emails = ? where id = ?",
      ...values,
      config.id,
    );
  };

  return {
    list: () =>
      (
        store.all("select * from oidc_providers order by created_at") as Row[]
      ).map(configOf),
    get,
    create: (input) => {
      const config = configFrom(randomUUID(), input, undefined);
      save(config, true);

      return config;
    },
    update: (id, input) => {
      const current = get(id);
      if (current === undefined) {
        return undefined;
      }

      const config = configFrom(id, input, current.clientSecret);
      save(config, false);

      return config;
    },
    remove: (id) => {
      const found = get(id) !== undefined;
      store.run("delete from oidc_providers where id = ?", id);

      return found;
    },
  };
}

// The web never gets a client secret back, only whether one is set.
export function viewOf({
  clientSecret,
  ...config
}: ProviderConfig): ProviderView {
  return { ...config, hasClientSecret: clientSecret !== undefined };
}

function configFrom(
  id: string,
  input: unknown,
  secret: string | undefined,
): ProviderConfig {
  const fields = (
    typeof input === "object" && input !== null ? input : {}
  ) as Partial<Record<keyof ProviderInput, unknown>>;

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

  // null takes the secret away, and empty keeps it.
  let clientSecret = fields.clientSecret === null ? undefined : secret;
  const entered = fields.clientSecret === null ? "" : text("clientSecret");

  if (entered !== "") {
    clientSecret = entered;
  }

  return {
    id,
    label: text("label", "Sign in with single sign-on"),
    issuer,
    clientId,
    clientSecret,
    groupsClaim: text("groupsClaim", "groups"),
    accessGroup: text("accessGroup"),
    adminGroup: text("adminGroup"),
    allowedEmails: list("allowedEmails"),
    allowedDomains: list("allowedDomains"),
    adminEmails: list("adminEmails"),
  };
}
