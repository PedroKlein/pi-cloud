import type { AliasConfig, Backend, Health, Unhealthy } from "./model";

export const gatewayProvider = "alias";

const tierOrder = ["heavy", "medium", "light", "xlight", "minimal"];
const transientCooldownMs = 60_000;
const defaultCapCooldownMs = 60 * 60_000;
const defaultCapStatusCodes = [402];

const capPattern =
  /insufficient_quota|quota exceeded|out of budget|billing|usage limit/i;

const transientPattern =
  /\b(408|425|429|500|502|503|504)\b|rate.?limit|too many requests|overloaded|unavailable|timed? ?out|network|connection|fetch failed/i;

export interface Alias {
  readonly id: string;
  readonly tier: string;
  readonly index: number;
}

export interface Candidate {
  readonly backend: string;
  readonly modelId: string;
}

const modelsOf = (backend: Backend, tier: string): readonly string[] => {
  const models = backend.tiers[tier];

  return models === undefined ? [] : [models].flat();
};

// Backends in routing order: the fallback chain, then any others, never the
// force-only ones.
export function chainOf(config: AliasConfig): readonly string[] {
  const names = Object.keys(config.backends);
  const chain = [...(config.fallbackChain ?? []), ...names];

  return [...new Set(chain)].filter(
    (name) => config.backends[name]?.forceOnly !== true && names.includes(name),
  );
}

// heavy-1, heavy-2, ...: the count per tier comes from the first backend in
// the chain that has the tier, so the names stay the same while backends
// come and go.
export function aliasesOf(config: AliasConfig): readonly Alias[] {
  const chain = chainOf(config);

  const tiers = Object.values(config.backends).flatMap((backend) =>
    Object.keys(backend.tiers),
  );

  const ordered = [
    ...tierOrder.filter((tier) => tiers.includes(tier)),
    ...[...new Set(tiers)].filter((tier) => !tierOrder.includes(tier)),
  ];

  return ordered.flatMap((tier) => {
    const first = chain
      .map((name) => config.backends[name])
      .find(
        (backend) =>
          backend !== undefined && modelsOf(backend, tier).length > 0,
      );

    const count = first ? modelsOf(first, tier).length : 0;

    return Array.from({ length: count }, (_, i) => ({
      id: `${tier}-${String(i + 1)}`,
      tier,
      index: i + 1,
    }));
  });
}

export function unhealthy(
  health: Health,
  backend: string,
  now: Date,
): Unhealthy | undefined {
  const entry = health.unhealthyUntil[backend];

  return entry !== undefined && Date.parse(entry.until) > now.getTime()
    ? entry
    : undefined;
}

// Each healthy backend's model for the alias, in routing order. A backend with
// fewer models than the alias index gives its last one.
export function candidates(
  config: AliasConfig,
  health: Health,
  alias: Alias,
  now: Date,
): readonly Candidate[] {
  return chainOf(config).flatMap((backend) => {
    const models = modelsOf(
      config.backends[backend] ?? { tiers: {} },
      alias.tier,
    );

    const modelId = models[Math.min(alias.index, models.length) - 1];

    return modelId === undefined || unhealthy(health, backend, now)
      ? []
      : [{ backend, modelId }];
  });
}

// How long a failed response takes its backend out of routing, if at all.
export function failure(
  config: AliasConfig,
  backend: string,
  errorMessage: string,
  now: Date,
): Unhealthy | undefined {
  const settings = config.backends[backend];
  if (settings === undefined) {
    return undefined;
  }

  const codes = settings.capStatusCodes ?? defaultCapStatusCodes;
  const statuses = (errorMessage.match(/\b\d{3}\b/g) ?? []).map(Number);
  const reason = errorMessage.slice(0, 200);

  if (
    statuses.some((status) => codes.includes(status)) ||
    capPattern.test(errorMessage)
  ) {
    return {
      until: resetAfter(settings.resetSchedule, now).toISOString(),
      reason,
    };
  }

  if (transientPattern.test(errorMessage)) {
    return {
      until: new Date(now.getTime() + transientCooldownMs).toISOString(),
      reason,
    };
  }

  return undefined;
}

function resetAfter(schedule: string | undefined, now: Date): Date {
  const next = new Date(now);

  switch (schedule) {
    case "utc-midnight":
      next.setUTCHours(24, 0, 0, 0);

      return next;
    case "utc-hourly":
      next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0);

      return next;
    case "utc-monthly-1st":
      next.setUTCMonth(next.getUTCMonth() + 1, 1);
      next.setUTCHours(0, 0, 0, 0);

      return next;
    case undefined:
    default:
      return new Date(now.getTime() + defaultCapCooldownMs);
  }
}
