import { expect, test } from "bun:test";
import type {
  Assignment,
  Attempt,
  Removal,
  Work,
  WorkPoll,
} from "@pi-cloud/protocol";
import { runProvider } from "./index";

const assignment: Assignment = {
  sessionId: "s1",
  generation: 1,
  workspace: { kind: "folder", path: "/w" },
  model: null,
  systemPrompt: null,
  firstMessage: null,
  plugins: [],
};

const none: Work = { start: [], unload: [], remove: [] };

const removal: Removal = {
  sessionId: "s2",
  workspace: { kind: "clone", repository: "r", branch: "b" },
  force: false,
};

const ignore = { unload: () => undefined, remove: () => undefined };

test("starts, unloads and removes what the server asks and retries failed polls", async () => {
  const controller = new AbortController();

  const responses: (() => Work)[] = [
    () => {
      throw new Error("connection refused");
    },
    () => none,
    () => ({
      start: [assignment],
      unload: [{ sessionId: "s3", generation: 4 }],
      remove: [removal],
    }),
  ];

  const started: Assignment[] = [];
  const unloaded: Attempt[] = [];
  const removed: Removal[] = [];
  const logs: string[] = [];

  await runProvider({
    controlPlane: {
      work: async () => {
        await Promise.resolve();
        const next = responses.shift();
        if (!next) {
          controller.abort();

          return none;
        }

        return next();
      },
    },
    start: (a) => {
      started.push(a);
    },
    unload: (a) => {
      unloaded.push(a);
    },
    remove: (r) => {
      removed.push(r);
    },
    running: () => [],
    folders: [],
    models: [],
    log: (message) => logs.push(message),
    signal: controller.signal,
    retry: { initialMs: 1, maxMs: 1 },
  });

  expect(started).toEqual([assignment]);
  expect(unloaded).toEqual([{ sessionId: "s3", generation: 4 }]);
  expect(removed).toEqual([removal]);
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
    ...ignore,
    running: () => [],
    folders: [],
    models: [],
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

test("reports the running attempts, folders and models with every poll", async () => {
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

        return none;
      },
    },
    start: () => undefined,
    ...ignore,
    running: () => running,
    folders: ["/work"],
    models: [{ provider: "openai", id: "gpt-5-mini" }],
    log: () => undefined,
    signal: controller.signal,
  });

  const poll = {
    running,
    folders: ["/work"],
    models: [{ provider: "openai", id: "gpt-5-mini" }],
  };

  expect(polls).toEqual([poll, poll]);
});
