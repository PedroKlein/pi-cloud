import { expect, test } from "bun:test";
import { addUsage, describeUsage, type Usage } from "./usage";

const assistant = (
  model: string,
  usage: { input: number; output: number; cacheRead: number; cost: number },
): string =>
  JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      provider: "faux",
      model,
      content: [],
      usage: {
        ...usage,
        cacheWrite: 0,
        totalTokens: usage.input + usage.output + usage.cacheRead,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: usage.cost,
        },
      },
    },
  });

const totals = (lines: readonly string[]): ReadonlyMap<string, Usage> =>
  lines.reduce(addUsage, new Map<string, Usage>());

test("sums tokens and cost per model and in total", () => {
  const usage = describeUsage(
    totals([
      assistant("small", {
        input: 800,
        output: 100,
        cacheRead: 0,
        cost: 0.001,
      }),
      assistant("small", {
        input: 200,
        output: 50,
        cacheRead: 1000,
        cost: 0.002,
      }),
      assistant("large", {
        input: 500,
        output: 1200,
        cacheRead: 0,
        cost: 0.01,
      }),
    ]),
  );

  expect(usage).toEqual({
    summary: "2.5k in · 1.4k out · $0.0130",
    detail:
      "faux/small: 2.0k in · 150 out · $0.0030\nfaux/large: 500 in · 1.2k out · $0.0100",
  });
});

test("ignores entries without usage", () => {
  const lines = [
    JSON.stringify({ type: "session", id: "s" }),
    JSON.stringify({
      type: "message",
      message: { role: "user", content: "hi" },
    }),
    JSON.stringify({
      type: "message",
      message: { role: "toolResult", toolName: "read", content: [] },
    }),
  ];

  expect(describeUsage(totals(lines))).toEqual({ summary: "", detail: "" });
});
