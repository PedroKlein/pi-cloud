import { expect, test } from "bun:test";
import { aliasesOf, candidates, failure } from "./gateway";
import type { AliasConfig } from "./model";

const config: AliasConfig = {
  fallbackChain: ["copilot", "google"],
  backends: {
    copilot: {
      tiers: { medium: ["gpt-5.3-codex", "claude-sonnet"], light: "gpt-mini" },
    },
    google: {
      tiers: { medium: "gemini-flash" },
      resetSchedule: "utc-midnight",
    },
  },
};

const now = new Date("2026-10-21T20:30:00Z");

test("names aliases by tier, counted from the first backend in the chain", () => {
  expect(aliasesOf(config).map(({ id }) => id)).toEqual([
    "medium-1",
    "medium-2",
    "light-1",
  ]);
});

test("routes past an unhealthy backend and clamps to a shorter list", () => {
  const health = {
    version: 1,
    unhealthyUntil: {
      copilot: { until: "2026-10-21T21:00:00Z", reason: "402" },
    },
  } as const;

  expect(
    candidates(
      config,
      health,
      { id: "medium-2", tier: "medium", index: 2 },
      now,
    ),
  ).toEqual([{ backend: "google", modelId: "gemini-flash" }]);
});

test("cools a rate limit down for a minute and holds a cap until its reset", () => {
  expect(failure(config, "google", "429 Too Many Requests", now)?.until).toBe(
    "2026-10-21T20:31:00.000Z",
  );

  expect(failure(config, "google", "402 Payment Required", now)?.until).toBe(
    "2026-10-22T00:00:00.000Z",
  );

  expect(failure(config, "google", "context too long", now)).toBeUndefined();
});
