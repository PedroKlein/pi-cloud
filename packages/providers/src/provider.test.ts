import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  emptyProfile,
  type SessionStart,
  type Attempt,
  type Removal,
  type Work,
  type WorkPoll,
} from "@pi-cloud/protocol";
import { runProvider } from "./index";

const assignment: SessionStart = {
  token: "pct_test",
  sessionId: "s1",
  generation: 1,
  profile: { id: "profile-1", ...emptyProfile },
  trusted: null,
  workspace: { kind: "folder", path: "/w" },
  model: null,
  thinking: null,
  systemPrompt: null,
  firstMessage: null,
  plugins: [],
  environment: {
    isolation: "process",
    image: null,
    setupScript: "",
    variables: { TOKEN: "s3cret" },
  },
};

const none: Work = { start: [], unload: [], remove: [], profiles: [] };

const removal: Removal = {
  sessionId: "s2",
  generation: 1,
  workspace: { kind: "clone", repository: "r", branch: "b" },
  force: false,
};

const ignore = {
  unload: () => undefined,
  remove: () => undefined,
  profiles: () => undefined,
};

test("starts, unloads and removes what the server asks, passes on its Profiles and retries failed polls", async () => {
  const controller = new AbortController();

  const responses: (() => Work)[] = [
    () => {
      throw new Error("connection refused");
    },
    () => ({ ...none, profiles: ["p1"] }),
    // As an older server answers, with no Profiles.
    () =>
      ({
        start: [assignment],
        unload: [{ sessionId: "s3", generation: 4 }],
        remove: [removal],
      }) as unknown as Work,
  ];

  const started: SessionStart[] = [];
  const unloaded: Attempt[] = [];
  const removed: Removal[] = [];
  const profiles: (readonly string[])[] = [];
  const logs: string[] = [];
  const fields: unknown[] = [];

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
    profiles: (ids) => {
      profiles.push(ids);
    },
    running: () => [],
    folders: [],
    models: () => [],
    log: (message, logged) => {
      logs.push(message);
      fields.push(logged);
    },
    signal: controller.signal,
    retry: { initialMs: 1, maxMs: 1 },
  });

  expect(started).toEqual([assignment]);
  expect(unloaded).toEqual([{ sessionId: "s3", generation: 4 }]);
  expect(removed).toEqual([removal]);
  expect(profiles).toEqual([["p1"], []]);
  expect(logs).toContain("work poll failed");
  expect(logs.at(-1)).toBe("provider stopped");
  expect(JSON.stringify(fields)).not.toContain("s3cret");
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
    models: () => [],
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

test("reports the running attempts, folders and current models with every poll", async () => {
  const controller = new AbortController();
  const polls: WorkPoll[] = [];
  const running = [{ sessionId: "s1", generation: 2 }];
  const mini = { provider: "openai", id: "gpt-5-mini" };

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
    models: () =>
      polls.length === 0
        ? [mini]
        : [mini, { provider: "anthropic", id: "claude-haiku" }],
    log: () => undefined,
    signal: controller.signal,
  });

  expect(polls).toEqual([
    { running, folders: ["/work"], models: [mini] },
    {
      running,
      folders: ["/work"],
      models: [mini, { provider: "anthropic", id: "claude-haiku" }],
    },
  ]);
});

test("stops Sessions whose Workspace can move once polls fail for half a lease", async () => {
  const controller = new AbortController();

  const clone: SessionStart = {
    ...assignment,
    sessionId: "s2",
    workspace: { kind: "clone", repository: "r", branch: "b" },
  };

  const running = new Map<string, Attempt>();
  const unloaded: Attempt[] = [];
  let polls = 0;

  const stopped = runProvider({
    controlPlane: {
      work: async () => {
        polls++;
        if (polls === 1) {
          return { ...none, start: [assignment, clone] };
        }

        return Promise.reject(new Error("unreachable"));
      },
    },
    start: (a) => {
      running.set(a.sessionId, {
        sessionId: a.sessionId,
        generation: a.generation,
      });
    },
    unload: (a) => {
      unloaded.push(a);
      running.delete(a.sessionId);
    },
    remove: () => undefined,
    profiles: () => undefined,
    running: () => [...running.values()],
    folders: [],
    models: () => [],
    log: () => undefined,
    signal: controller.signal,
    retry: { initialMs: 5, maxMs: 5 },
    leaseMs: 100,
  });

  await sleep(150);
  controller.abort();
  await stopped;

  expect(unloaded).toEqual([{ sessionId: "s2", generation: 1 }]);
});
