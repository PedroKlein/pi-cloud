// The alias config of one Environment. Each alias tries its models in order,
// and each model is a `provider/id` of a Pi model on that Environment's
// machine, so one alias can mix providers.
export interface AliasConfig {
  readonly models: Readonly<Record<string, readonly string[]>>;
  // How a provider's account runs out, for errors that bench all its models.
  readonly providers?: Readonly<Record<string, ProviderSettings>>;
  // The alias a Session in this Environment gets when it names no model.
  readonly defaultAlias?: string;
}

export interface ProviderSettings {
  readonly resetSchedule?: string;
  readonly capStatusCodes?: readonly number[];
}

export interface Unhealthy {
  readonly until: string;
  readonly reason: string;
  readonly quota?: {
    readonly spent: number;
    readonly cap: number;
    readonly currency: string;
  };
}

// Keyed by a provider, when its account hit a cap, or by a `provider/id`, when
// one model hit a rate limit or an outage.
export interface Health {
  readonly version: 1;
  readonly unhealthyUntil: Readonly<Record<string, Unhealthy>>;
}

export interface EnvironmentModels {
  readonly environmentId: string;
  readonly aliases: AliasConfig | null;
  readonly health: Health;
}

// What a Session reads: its Environment's config, and a version that changes
// whenever the config or the health does.
export interface SessionConfig {
  readonly version: number;
  readonly aliases: AliasConfig | null;
  readonly health: Health;
}

export interface ModelRef {
  readonly provider: string;
  readonly id: string;
}

export const noHealth: Health = { version: 1, unhealthyUntil: {} };

const aliasName = /^[A-Za-z0-9][\w.-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isIntegers = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => Number.isInteger(item));

const isQuota = (value: unknown): value is NonNullable<Unhealthy["quota"]> =>
  isRecord(value) &&
  typeof value["spent"] === "number" &&
  typeof value["cap"] === "number" &&
  typeof value["currency"] === "string";

// Pi provider names have no slash, but some model ids do.
export function modelRef(value: string): ModelRef | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    return undefined;
  }

  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

// The shape a gateway needs to start. Sessions report anything finer, such as
// a model their machine doesn't have.
export function aliasProblem(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value["models"])) {
    return "aliases need a models object";
  }

  const aliases = Object.entries(value["models"]);
  if (aliases.length === 0) {
    return "aliases need at least one alias";
  }

  for (const [name, models] of aliases) {
    if (!aliasName.test(name)) {
      return `alias ${name} must be letters, digits, dots, dashes or underscores`;
    }

    if (!isStrings(models) || models.length === 0) {
      return `alias ${name} needs a list of models`;
    }

    const bad = models.find((model) => modelRef(model) === undefined);
    if (bad !== undefined) {
      return `model ${bad} of ${name} must be provider/id`;
    }
  }

  const { providers, defaultAlias } = value;
  if (providers !== undefined) {
    if (!isRecord(providers)) {
      return "providers must be an object";
    }

    for (const [name, settings] of Object.entries(providers)) {
      const problem = providerProblem(name, settings);
      if (problem !== undefined) {
        return problem;
      }
    }
  }

  if (
    defaultAlias !== undefined &&
    (typeof defaultAlias !== "string" || !(defaultAlias in value["models"]))
  ) {
    return "defaultAlias must be one of the aliases";
  }

  return undefined;
}

function providerProblem(name: string, settings: unknown): string | undefined {
  if (!isRecord(settings)) {
    return `provider ${name} needs a settings object`;
  }

  const { capStatusCodes, resetSchedule } = settings;
  if (capStatusCodes !== undefined && !isIntegers(capStatusCodes)) {
    return `capStatusCodes of ${name} must be a list of status codes`;
  }

  if (resetSchedule !== undefined && typeof resetSchedule !== "string") {
    return `resetSchedule of ${name} must be a schedule name`;
  }

  return undefined;
}

// Configs saved before aliases listed their own models were pi-gateway's
// aliases.json: backends with tiers of model ids and a fallback chain. Alias
// `<tier>-<n>` took the n-th model of each backend in chain order, with the
// count from the first backend that had the tier.
export function storedAliases(value: unknown): AliasConfig {
  if (!isRecord(value) || !isRecord(value["backends"])) {
    return value as AliasConfig;
  }

  const backends = value["backends"] as Record<
    string,
    {
      readonly tiers: Record<string, string | string[]>;
      readonly forceOnly?: boolean;
      readonly resetSchedule?: string;
      readonly capStatusCodes?: number[];
    }
  >;

  const names = Object.keys(backends);

  const fallbackChain = isStrings(value["fallbackChain"])
    ? value["fallbackChain"]
    : [];

  const chain = [...new Set([...fallbackChain, ...names])].filter(
    (name) => names.includes(name) && backends[name]?.forceOnly !== true,
  );

  const tiersOf = (name: string, tier: string): readonly string[] => {
    const models = backends[name]?.tiers[tier];

    return models === undefined ? [] : [models].flat();
  };

  const tierOrder = ["heavy", "medium", "light", "xlight", "minimal"];

  const tiers = [
    ...new Set(
      Object.values(backends).flatMap((backend) => Object.keys(backend.tiers)),
    ),
  ].sort(
    (a, b) =>
      (tierOrder.indexOf(a) + 1 || Infinity) -
      (tierOrder.indexOf(b) + 1 || Infinity),
  );

  const models = Object.fromEntries(
    tiers.flatMap((tier) => {
      const first = chain.find((name) => tiersOf(name, tier).length > 0);
      const count = first === undefined ? 0 : tiersOf(first, tier).length;

      return Array.from({ length: count }, (_, i) => [
        `${tier}-${String(i + 1)}`,
        chain.flatMap((name) => {
          const ids = tiersOf(name, tier);
          const id = ids[Math.min(i + 1, ids.length) - 1];

          return id === undefined ? [] : [`${name}/${id}`];
        }),
      ]);
    }),
  );

  const providers = Object.fromEntries(
    names.flatMap((name) => {
      const { resetSchedule, capStatusCodes } = backends[name] ?? {};

      const settings = {
        ...(resetSchedule !== undefined && { resetSchedule }),
        ...(capStatusCodes !== undefined && { capStatusCodes }),
      };

      return Object.keys(settings).length === 0 ? [] : [[name, settings]];
    }),
  );

  const defaultAlias = value["defaultAlias"];

  return {
    models,
    ...(Object.keys(providers).length > 0 && { providers }),
    ...(typeof defaultAlias === "string" &&
      defaultAlias in models && { defaultAlias }),
  };
}

export function healthFrom(value: unknown): Health | undefined {
  if (!isRecord(value) || !isRecord(value["unhealthyUntil"])) {
    return undefined;
  }

  const unhealthyUntil: Record<string, Unhealthy> = {};
  for (const [key, entry] of Object.entries(value["unhealthyUntil"])) {
    if (!isRecord(entry)) {
      return undefined;
    }

    const { until, reason, quota } = entry;
    if (typeof until !== "string" || typeof reason !== "string") {
      return undefined;
    }

    unhealthyUntil[key] = {
      until,
      reason,
      ...(isQuota(quota) && { quota }),
    };
  }

  return { version: 1, unhealthyUntil };
}

// Sessions report their whole state, which may be older than another
// Session's report. For each provider or model the later reset wins, and a
// reset that has passed is dropped.
export function mergeHealth(
  current: Health,
  reported: Health,
  now: Date,
): Health {
  const unhealthyUntil: Record<string, Unhealthy> = {};

  for (const entries of [current.unhealthyUntil, reported.unhealthyUntil]) {
    for (const [key, entry] of Object.entries(entries)) {
      const until = Date.parse(entry.until);
      const kept = unhealthyUntil[key];

      if (
        until > now.getTime() &&
        (kept === undefined || until > Date.parse(kept.until))
      ) {
        unhealthyUntil[key] = entry;
      }
    }
  }

  return { version: 1, unhealthyUntil };
}
