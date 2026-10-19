import { expect, test } from "bun:test";
import type { Assignment, Work, WorkPoll } from "@pi-cloud/protocol";
import { runProvider } from "./index";

const assignment: Assignment = { sessionId: "s1", generation: 1, cwd: "/w" };

test("starts assigned sessions and retries failed polls", async () => {
  const controller = new AbortController();
  const responses: (() => Work)[] = [
    () => {
      throw new Error("connection refused");
    },
    () => ({ start: [] }),
    () => ({ start: [assignment] }),
  ];
  const started: Assignment[] = [];
  const logs: string[] = [];

  await runProvider({
    controlPlane: {
      work: async () => {
        await Promise.resolve();
        const next = responses.shift();
        if (!next) {
          controller.abort();
          return { start: [] };
        }
        return next();
      },
    },
    start: (a) => {
      started.push(a);
    },
    running: () => [],
    log: (message) => logs.push(message),
    signal: controller.signal,
    retry: { initialMs: 1, maxMs: 1 },
  });

  expect(started).toEqual([assignment]);
  expect(logs).toContain("work poll failed");
  expect(logs.at(-1)).toBe("provider stopped");
});

test("stops while waiting to retry", async () => {
  const controller = new AbortController();
  const logs: string[] = [];
  const stopped = runProvider({
    controlPlane: {
      work: async () => Promise.reject(new Error("down")),
    },
    start: () => undefined,
    running: () => [],
    log: (message) => {
      logs.push(message);
    },
    signal: controller.signal,
    retry: { initialMs: 60_000, maxMs: 60_000 },
  });

  controller.abort();
  await stopped;

  expect(logs.at(-1)).toBe("provider stopped");
});

test("reports the running attempts with every poll", async () => {
  const controller = new AbortController();
  const polls: WorkPoll[] = [];
  const running = [{ sessionId: "s1", generation: 2 }];

  await runProvider({
    controlPlane: {
      work: async (poll) => {
        await Promise.resolve();
        polls.push(poll);
        if (polls.length === 2) {
          controller.abort();
        }
        return { start: [] };
      },
    },
    start: () => undefined,
    running: () => running,
    log: () => undefined,
    signal: controller.signal,
  });

  expect(polls).toEqual([{ running }, { running }]);
});
