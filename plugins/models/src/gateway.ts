import {
  type AliasConfig,
  type Health,
  type ModelRef,
  modelRef,
  type Unhealthy,
} from "./model";

export const gatewayProvider = "alias";

const transientCooldownMs = 60_000;
const defaultCapCooldownMs = 60 * 60_000;
const defaultCapStatusCodes = [402];

const capPattern =
  /insufficient_quota|quota exceeded|out of budget|billing|usage limit/i;

// A per-minute quota reads like a cap ("Quota exceeded ... check your plan and
// billing details") but clears within a minute.
const shortWindowPattern = /per.?minute|retry in \d+(\.\d+)?m?s\b/i;

const transientPattern =
  /\b(408|425|429|500|502|503|504)\b|rate.?limit|too many requests|overloaded|unavailable|timed? ?out|network|connection|fetch failed/i;

export const modelKey = ({ provider, id }: ModelRef): string =>
  `${provider}/${id}`;

export function aliasesOf(config: AliasConfig): readonly string[] {
  return Object.keys(config.models);
}

// Why a model is out of routing: its provider's account hit a cap, or the
// model itself is cooling down.
export function unhealthy(
  health: Health,
  model: ModelRef,
  now: Date,
): Unhealthy | undefined {
  return [model.provider, modelKey(model)]
    .map((key) => health.unhealthyUntil[key])
    .find(
      (entry) => entry !== undefined && Date.parse(entry.until) > now.getTime(),
    );
}

// The alias's healthy models, in its order.
export function candidates(
  config: AliasConfig,
  health: Health,
  alias: string,
  now: Date,
): readonly ModelRef[] {
  return (config.models[alias] ?? []).flatMap((value) => {
    const model = modelRef(value);

    return model === undefined || unhealthy(health, model, now) ? [] : [model];
  });
}

// What a failed response takes out of routing, and until when: a cap benches
// the provider's whole account, anything transient only the model.
export function failure(
  config: AliasConfig,
  model: ModelRef,
  errorMessage: string,
  now: Date,
): { readonly key: string; readonly entry: Unhealthy } | undefined {
  const settings = config.providers?.[model.provider] ?? {};
  const codes = settings.capStatusCodes ?? defaultCapStatusCodes;
  const statuses = (errorMessage.match(/\b\d{3}\b/g) ?? []).map(Number);
  const reason = errorMessage.slice(0, 200);

  if (
    statuses.some((status) => codes.includes(status)) ||
    (capPattern.test(errorMessage) && !shortWindowPattern.test(errorMessage))
  ) {
    return {
      key: model.provider,
      entry: {
        until: resetAfter(settings.resetSchedule, now).toISOString(),
        reason,
      },
    };
  }

  if (transientPattern.test(errorMessage)) {
    return {
      key: modelKey(model),
      entry: {
        until: new Date(now.getTime() + transientCooldownMs).toISOString(),
        reason,
      },
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
