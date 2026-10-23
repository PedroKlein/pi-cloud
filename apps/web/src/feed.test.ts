import { expect, test } from "bun:test";
import type { LiveEvent, Prompt, Session } from "@pi-cloud/protocol";
import { type Feed, feedReader } from "./feed";

const session = (waiting: boolean): Session => ({
  id: "s",
  environmentId: "e",
  ownerId: "o",
  provider: "laptop",
  workspace: { kind: "folder", path: "/home/me/site" },
  model: { provider: "github-copilot", id: "gpt-5.3-codex" },
  thinking: null,
  systemPrompt: null,
  firstMessage: null,
  title: null,
  status: "running",
  generation: 1,
  createdAt: "2026-10-21T00:00:00Z",
  interruptedAt: null,
  error: null,
  archivedAt: null,
  workspaceRemoval: null,
  workspaceKeptReason: null,
  online: true,
  waiting,
});

const prompt = (id: string): Prompt => ({
  id,
  kind: "confirm",
  title: "Go?",
  message: "ok",
});

const explanation: LiveEvent = {
  type: "explanation",
  id: "p1",
  questionId: "q",
  value: "a",
  question: null,
  text: "because",
  error: null,
};

const connect = (): {
  readonly feeds: Feed[];
  readonly open: () => void;
  readonly live: (event: LiveEvent) => void;
  readonly session: (waiting: boolean) => void;
} => {
  const feeds: Feed[] = [];

  const reader = feedReader({
    dispatch: () => undefined,
    onChange: (feed) => feeds.push(feed),
    onSession: () => undefined,
  });

  reader.open();

  return {
    feeds,
    open: reader.open,
    live: (event) => {
      reader.receive({ type: "live", event });
    },
    session: (waiting) => {
      reader.receive({ type: "session", session: session(waiting) });
    },
  };
};

const prompts = (feed: Feed | undefined): string[] =>
  (feed?.prompts ?? []).map((open) => open.prompt.id);

test("a reconnect keeps an open prompt and the explanations asked about it", () => {
  const stream = connect();
  stream.live({ type: "prompt", prompt: prompt("p1") });
  stream.live(explanation);

  const before = stream.feeds.length;
  stream.open();
  stream.session(true);
  stream.live({ type: "prompt", prompt: prompt("p1") });

  expect(stream.feeds.slice(before).map(prompts)).not.toContainEqual([]);
  expect(stream.feeds.at(-1)?.prompts[0]?.explanations).toEqual([explanation]);
});

test("a reconnect drops prompts that ended while the stream was down", () => {
  const stream = connect();
  stream.live({ type: "prompt", prompt: prompt("p1") });
  stream.live({ type: "prompt", prompt: prompt("p2") });

  stream.open();
  stream.session(true);
  stream.live({ type: "prompt", prompt: prompt("p2") });
  stream.live({ type: "status", status: "running" });

  expect(prompts(stream.feeds.at(-1))).toEqual(["p2"]);

  stream.open();
  stream.session(false);

  expect(prompts(stream.feeds.at(-1))).toEqual([]);
});

test("a reconnect drops text streamed before the stream went down", () => {
  const stream = connect();
  stream.live({ type: "text", delta: "Hello wor" });

  stream.open();
  stream.live({ type: "text", delta: " more" });

  expect(stream.feeds.at(-1)?.streaming).toBe(" more");
});
