import { expect, test } from "bun:test";
import { healthFrom } from "./model";

test("keeps only the until, reason and a well-formed quota of reported health", () => {
  const capped = { until: "2026-10-22T00:00:00Z", reason: "402" };
  const limited = { until: "2026-10-21T20:31:00Z", reason: "429" };
  const quota = { spent: 10, cap: 10, currency: "USD" };

  expect(
    healthFrom({
      version: 1,
      unhealthyUntil: {
        capped: { ...capped, quota, note: "from a newer gateway" },
        limited: { ...limited, quota: 5 },
      },
    }),
  ).toEqual({
    version: 1,
    unhealthyUntil: { capped: { ...capped, quota }, limited },
  });
});
