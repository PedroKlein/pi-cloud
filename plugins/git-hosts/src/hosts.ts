import type { PluginConfig, PluginStore } from "@pipoca/plugins";
import type { HostView } from "./model";

export interface HostConfig {
  readonly host: string;
  readonly label: string;
  // The REST API's base address.
  readonly api: string;
  readonly oauth: OAuthApp | undefined;
}

export interface OAuthApp {
  readonly clientId: string;
  // GitHub's OAuth apps need a secret, so without one people paste a token.
  readonly clientSecret: string | undefined;
  readonly clientSecretEnv: string | undefined;
}

export class InvalidHost extends Error {}

export interface HostStore {
  readonly list: () => readonly HostConfig[];
  readonly get: (host: string) => HostConfig | undefined;
  readonly create: (input: unknown) => HostConfig;
  // An empty or missing client secret keeps the one the host has, and null
  // takes it away.
  readonly update: (host: string, input: unknown) => HostConfig | undefined;
  readonly remove: (host: string) => boolean;
}

// A host and its client secret as the file holds them, sealed, so a save that
// keeps the secret writes the same text back.
interface Entry {
  readonly config: HostConfig;
  readonly sealed: string | undefined;
}

const github: HostConfig = {
  host: "github.com",
  label: "GitHub",
  api: "https://api.github.com",
  oauth: undefined,
};

// The hosts live under the plugin's key in pipoca.json, which Settings and
// people both edit (ADR 0039). With no list in the file, github.com is the
// one host (ADR 0043). A list that stops fitting is logged, and the last one
// that fit stays in use.
export function hostStore(
  config: PluginConfig,
  store: PluginStore,
  env: NodeJS.ProcessEnv,
  log: (message: string, fields?: Readonly<Record<string, unknown>>) => void,
): HostStore {
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
    entriesOf(value, (sealed, host) => store.open(sealed, host), secretIn);

  let read = JSON.stringify(config.get());
  let entries = parse(config.get());

  // Why the hosts in the file stopped fitting. A save would write the last
  // ones that fit over what someone wrote there by hand.
  let unfit: string | undefined;

  const current = (): readonly Entry[] => {
    const value = config.get();
    const serialized = JSON.stringify(value);

    if (serialized !== read) {
      read = serialized;

      try {
        entries = parse(value);
        unfit = undefined;
      } catch (failure) {
        unfit = failure instanceof Error ? failure.message : String(failure);

        log("hosts in the config file don't fit", {
          error: unfit,
        });
      }
    }

    return entries;
  };

  const save = (next: readonly Entry[]): void => {
    current();
    if (unfit !== undefined) {
      throw new InvalidHost(`fix git-hosts in pipoca.json first: ${unfit}`);
    }

    const value = config.get();

    try {
      config.set({
        ...(isObject(value) ? value : {}),
        hosts: next.map(fileEntry),
      });
    } catch (failure) {
      throw new InvalidHost(
        failure instanceof Error ? failure.message : String(failure),
      );
    }

    entries = next;
    read = JSON.stringify(config.get());
  };

  const get = (host: string): Entry | undefined =>
    current().find(({ config: each }) => each.host === host);

  const changed = (
    host: string,
    input: unknown,
    before: Entry | undefined,
  ): Entry => {
    const fields = fieldsOf(input);
    const secret = fields["clientSecret"];

    if (secret !== undefined && secret !== null && typeof secret !== "string") {
      throw new InvalidHost("clientSecret must be text");
    }

    const label = text(fields["label"], "label").trim() || host;
    const clientId = text(fields["clientId"], "clientId").trim();
    const base = { ...hostConfig(host, before?.config.api), label };

    if (clientId === "") {
      return { config: { ...base, oauth: undefined }, sealed: undefined };
    }

    if (secret !== undefined && secret !== null && secret.trim() !== "") {
      return {
        config: {
          ...base,
          oauth: {
            clientId,
            clientSecret: secret.trim(),
            clientSecretEnv: undefined,
          },
        },
        sealed: store.seal(secret.trim(), host),
      };
    }

    const kept = secret === null ? undefined : before?.config.oauth;

    return {
      config: {
        ...base,
        oauth: {
          clientId,
          clientSecret: kept?.clientSecret,
          clientSecretEnv: kept?.clientSecretEnv,
        },
      },
      sealed: secret === null ? undefined : before?.sealed,
    };
  };

  return {
    list: () => current().map((entry) => entry.config),
    get: (host) => get(host)?.config,
    create: (input) => {
      const host = hostName(fieldsOf(input)["host"]);

      if (get(host) !== undefined) {
        throw new InvalidHost(`${host} is already listed`);
      }

      const entry = changed(host, input, undefined);
      save([...current(), entry]);

      return entry.config;
    },
    update: (host, input) => {
      const before = get(host);
      if (before === undefined) {
        return undefined;
      }

      const entry = changed(host, input, before);
      save(current().map((each) => (each === before ? entry : each)));

      return entry.config;
    },
    remove: (host) => {
      const before = get(host);
      if (before === undefined) {
        return false;
      }

      save(current().filter((each) => each !== before));

      return true;
    },
  };
}

// The web never gets a client secret back, only whether one is set.
export function viewOf({ host, label, oauth }: HostConfig): HostView {
  return {
    host,
    label,
    clientId: oauth?.clientId ?? "",
    hasClientSecret: oauth?.clientSecret !== undefined,
    clientSecretEnv: oauth?.clientSecretEnv ?? null,
  };
}

function entriesOf(
  value: unknown,
  open: (sealed: string, host: string) => string,
  secretIn: (name: string) => string | undefined,
): readonly Entry[] {
  if (value === undefined) {
    return [{ config: github, sealed: undefined }];
  }

  if (!isObject(value)) {
    throw new InvalidHost("git-hosts in pipoca.json must be an object");
  }

  const { hosts } = value;

  if (hosts === undefined) {
    return [{ config: github, sealed: undefined }];
  }

  if (!Array.isArray(hosts)) {
    throw new InvalidHost("git-hosts.hosts must be a list");
  }

  const seen = new Set<string>();

  return hosts.map((item: unknown, index): Entry => {
    try {
      if (!isObject(item)) {
        throw new InvalidHost("must be an object");
      }

      const host = hostName(item["host"]);

      if (seen.has(host)) {
        throw new InvalidHost(`${host} is listed twice`);
      }

      seen.add(host);

      return entryOf(host, item, open, secretIn);
    } catch (failure) {
      if (failure instanceof InvalidHost) {
        throw new InvalidHost(
          `git-hosts.hosts[${String(index)}]: ${failure.message}`,
        );
      }

      throw failure;
    }
  });
}

function entryOf(
  host: string,
  item: Readonly<Record<string, unknown>>,
  open: (sealed: string, host: string) => string,
  secretIn: (name: string) => string | undefined,
): Entry {
  const { api, oauth } = item;

  if (api !== undefined && (typeof api !== "string" || !isHttp(api))) {
    throw new InvalidHost("api must be an http or https URL");
  }

  const base = {
    ...hostConfig(host, api),
    label: text(item["label"], "label").trim() || host,
  };

  if (oauth === undefined) {
    return { config: { ...base, oauth: undefined }, sealed: undefined };
  }

  if (!isObject(oauth)) {
    throw new InvalidHost("oauth must be an object");
  }

  const { clientId, clientSecret, clientSecretEnv } = oauth;

  if (typeof clientId !== "string" || clientId.trim() === "") {
    throw new InvalidHost("oauth.clientId must be text");
  }

  if (clientSecretEnv !== undefined) {
    const secret =
      typeof clientSecretEnv === "string"
        ? secretIn(clientSecretEnv)
        : undefined;

    if (typeof clientSecretEnv !== "string" || secret === undefined) {
      throw new InvalidHost(
        "oauth.clientSecretEnv names no environment variable that is set",
      );
    }

    return {
      config: {
        ...base,
        oauth: { clientId, clientSecret: secret, clientSecretEnv },
      },
      sealed: undefined,
    };
  }

  if (clientSecret !== undefined && typeof clientSecret !== "string") {
    throw new InvalidHost("oauth.clientSecret must be text");
  }

  return {
    config: {
      ...base,
      oauth: {
        clientId,
        clientSecret:
          clientSecret === undefined
            ? undefined
            : opened(clientSecret, host, open),
        clientSecretEnv: undefined,
      },
    },
    sealed: clientSecret,
  };
}

function opened(
  sealed: string,
  host: string,
  open: (sealed: string, host: string) => string,
): string {
  try {
    return open(sealed, host);
  } catch {
    throw new InvalidHost(
      "oauth.clientSecret must be sealed by Settings; name an environment variable in oauth.clientSecretEnv instead",
    );
  }
}

// What the file holds for a host, leaving out what is default.
function fileEntry({
  config,
  sealed,
}: Entry): Readonly<Record<string, unknown>> {
  const { host, label, api, oauth } = config;

  return {
    host,
    ...(label !== host && { label }),
    ...(api !== defaultApi(host) && { api }),
    ...(oauth && {
      oauth: {
        clientId: oauth.clientId,
        ...(oauth.clientSecretEnv !== undefined
          ? { clientSecretEnv: oauth.clientSecretEnv }
          : sealed !== undefined && { clientSecret: sealed }),
      },
    }),
  };
}

function hostConfig(
  host: string,
  api: string | undefined,
): Omit<HostConfig, "label" | "oauth"> {
  return { host, api: (api ?? defaultApi(host)).replace(/\/+$/, "") };
}

function defaultApi(host: string): string {
  return host === "github.com"
    ? "https://api.github.com"
    : `https://${host}/api/v3`;
}

// The host goes into git's config keys and gh's hosts.yml, so it is only a
// name and an optional port.
function hostName(value: unknown): string {
  const host = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host)) {
    throw new InvalidHost("host must be a host name, such as github.com");
  }

  return host;
}

function text(value: unknown, field: string): string {
  if (value === undefined) {
    return "";
  }

  if (typeof value !== "string") {
    throw new InvalidHost(`${field} must be text`);
  }

  return value;
}

function isHttp(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function fieldsOf(input: unknown): Readonly<Record<string, unknown>> {
  if (!isObject(input)) {
    throw new InvalidHost("expected an object");
  }

  return input;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
