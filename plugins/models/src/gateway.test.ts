import { expect, test } from "bun:test";
import { candidates, failure } from "./gateway";
import type { AliasConfig } from "./model";

const config: AliasConfig = {
  models: {
    "medium-1": [
      "github-copilot/claude-haiku-4.5",
      "google/gemini-flash",
      "github-copilot/gpt-5.3-codex",
    ],
  },
  providers: { google: { resetSchedule: "utc-midnight" } },
};

const now = new Date("2026-10-21T20:30:00Z");
const gemini = { provider: "google", id: "gemini-flash" };

test("routes an alias through its models in order, across providers, past unhealthy ones", () => {
  const health = {
    version: 1,
    unhealthyUntil: {
      "github-copilot/claude-haiku-4.5": {
        until: "2026-10-21T20:31:00Z",
        reason: "429",
      },
    },
  } as const;

  expect(candidates(config, health, "medium-1", now)).toEqual([
    gemini,
    { provider: "github-copilot", id: "gpt-5.3-codex" },
  ]);
});

test("a provider cap benches every model of that provider", () => {
  const health = {
    version: 1,
    unhealthyUntil: {
      "github-copilot": { until: "2026-10-22T00:00:00Z", reason: "402" },
    },
  } as const;

  expect(candidates(config, health, "medium-1", now)).toEqual([gemini]);
});

test("cools a rate-limited model down for a minute and holds a provider cap until its reset", () => {
  expect(failure(config, gemini, "429 Too Many Requests", now)).toEqual({
    key: "google/gemini-flash",
    entry: {
      until: "2026-10-21T20:31:00.000Z",
      reason: "429 Too Many Requests",
    },
  });

  expect(failure(config, gemini, "402 Payment Required", now)).toEqual({
    key: "google",
    entry: {
      until: "2026-10-22T00:00:00.000Z",
      reason: "402 Payment Required",
    },
  });

  expect(failure(config, gemini, "context too long", now)).toBeUndefined();
});

test("cools a per-minute quota down for a minute even when it mentions billing", () => {
  const message =
    "429 You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 15, model: gemini-3.5-flash-lite Please retry in 23.5s.";

  expect(failure(config, gemini, message, now)?.entry.until).toBe(
    "2026-10-21T20:31:00.000Z",
  );

  expect(
    failure(config, gemini, "429 insufficient_quota: check your billing", now)
      ?.entry.until,
  ).toBe("2026-10-22T00:00:00.000Z");
});
