// The alias config of one Environment, in pi-gateway's aliases.json shape:
// each backend is a Pi provider on that Environment's machine.
export interface AliasConfig {
  readonly fallbackChain?: readonly string[];
  // The alias a Session in this Environment gets when it names no model.
  readonly defaultAlias?: string;
  readonly backends: Readonly<Record<string, Backend>>;
}

export interface Backend {
  readonly tiers: Readonly<Record<string, string | readonly string[]>>;
  readonly forceOnly?: boolean;
  readonly resetSchedule?: string;
  readonly quotaHint?: string;
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

// pi-gateway's state shape, without the overrides only its TUI sets.
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

export const noHealth: Health = { version: 1, unhealthyUntil: {} };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

// The shape a gateway needs to start. Sessions report anything finer, such as
// a model their machine doesn't have.
export function aliasProblem(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value["backends"])) {
    return "aliases need a backends object";
  }

  const backends = Object.entries(value["backends"]);
  if (backends.length === 0) {
    return "aliases need at least one backend";
  }

  for (const [name, backend] of backends) {
    if (!isRecord(backend) || !isRecord(backend["tiers"])) {
      return `backend ${name} needs a tiers object`;
    }

    for (const [tier, models] of Object.entries(backend["tiers"])) {
      if (typeof models !== "string" && !isStrings(models)) {
        return `tier ${tier} of ${name} must be a model id or a list of them`;
      }
    }
  }

  const defaultAlias = value["defaultAlias"];
  if (defaultAlias !== undefined && typeof defaultAlias !== "string") {
    return "defaultAlias must be an alias name";
  }

  const chain = value["fallbackChain"];
  if (chain !== undefined && !isStrings(chain)) {
    return "fallbackChain must be a list of backend names";
  }

  return undefined;
}

export function healthFrom(value: unknown): Health | undefined {
  if (!isRecord(value) || !isRecord(value["unhealthyUntil"])) {
    return undefined;
  }

  const unhealthyUntil: Record<string, Unhealthy> = {};
  for (const [backend, entry] of Object.entries(value["unhealthyUntil"])) {
    if (
      !isRecord(entry) ||
      typeof entry["until"] !== "string" ||
      typeof entry["reason"] !== "string"
    ) {
      return undefined;
    }

    unhealthyUntil[backend] = entry as unknown as Unhealthy;
  }

  return { version: 1, unhealthyUntil };
}

// Sessions report their whole state, which may be older than another
// Session's report. For each backend the later reset wins, and a reset that
// has passed is dropped.
export function mergeHealth(
  current: Health,
  reported: Health,
  now: Date,
): Health {
  const unhealthyUntil: Record<string, Unhealthy> = {};

  for (const entries of [current.unhealthyUntil, reported.unhealthyUntil]) {
    for (const [backend, entry] of Object.entries(entries)) {
      const until = Date.parse(entry.until);
      const kept = unhealthyUntil[backend];

      if (
        until > now.getTime() &&
        (kept === undefined || until > Date.parse(kept.until))
      ) {
        unhealthyUntil[backend] = entry;
      }
    }
  }

  return { version: 1, unhealthyUntil };
}
