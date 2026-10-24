import { expect, jest, test } from "bun:test";
import type { LiveEvent, Prompt, Session } from "@pi-cloud/protocol";
import { type EventStream, type Feed, feedReader, followEvents } from "./feed";

const session = (waiting: boolean, change: Partial<Session> = {}): Session => ({
  id: "s",
  environmentId: "e",
  ownerId: "o",
  owner: null,
  provider: "laptop",
  runner: null,
  profileId: "profile-1",
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
  ...change,
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
  readonly session: (waiting: boolean, change?: Partial<Session>) => void;
  readonly entry: (message: unknown) => void;
} => {
  let line = 0;
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
    session: (waiting, change) => {
      reader.receive({ type: "session", session: session(waiting, change) });
    },
    entry: (message) => {
      reader.receive({
        type: "entry",
        line: line++,
        entry: JSON.stringify({ type: "message", message }),
      });
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

test("a transcript entry keeps a tool running until it holds the tool's result", () => {
  const stream = connect();
  stream.live({ type: "tool_start", toolCallId: "t1", toolName: "bash" });
  stream.live({ type: "tool_start", toolCallId: "t2", toolName: "read" });

  stream.entry({
    role: "assistant",
    content: [
      { type: "toolCall", id: "t1", name: "bash", arguments: {} },
      { type: "toolCall", id: "t2", name: "read", arguments: {} },
    ],
  });

  expect(stream.feeds.at(-1)?.tools.map(({ id }) => id)).toEqual(["t1", "t2"]);

  stream.entry({
    role: "toolResult",
    toolCallId: "t2",
    toolName: "read",
    content: "done",
  });

  expect(stream.feeds.at(-1)?.tools.map(({ id }) => id)).toEqual(["t1"]);
});

test("a session that stops or restarts drops what its Pi was doing", () => {
  const busy = (): ReturnType<typeof connect> => {
    const stream = connect();
    stream.session(true);
    stream.live({ type: "prompt", prompt: prompt("p1") });
    stream.live({ type: "tool_start", toolCallId: "t1", toolName: "bash" });
    stream.live({ type: "text", delta: "Working on" });

    return stream;
  };

  const live = (feed: Feed | undefined): unknown => ({
    prompts: prompts(feed),
    tools: feed?.tools,
    streaming: feed?.streaming,
  });

  const idle = { prompts: [], tools: [], streaming: undefined };

  for (const status of ["interrupted", "failed", "stopped"] as const) {
    const stream = busy();
    stream.session(false, { status });

    expect(live(stream.feeds.at(-1))).toEqual(idle);
  }

  const restarted = busy();
  restarted.session(false, { status: "starting", generation: 2 });

  expect(live(restarted.feeds.at(-1))).toEqual(idle);

  const running = busy();
  running.session(true, { status: "running" });

  expect(live(running.feeds.at(-1))).toEqual({
    prompts: ["p1"],
    tools: [{ id: "t1", name: "bash" }],
    streaming: "Working on",
  });
});

test("the answer stays on screen until the transcript holds the turn's last line", () => {
  const stream = connect();
  stream.entry({ role: "user", content: "hi" });
  stream.live({ type: "text", delta: "Hello" });
  stream.live({ type: "status", status: "idle", transcriptLength: 2 });

  expect(stream.feeds.at(-1)?.streaming).toBe("Hello");

  stream.entry({ role: "assistant", content: "Hello" });

  expect(stream.feeds.at(-1)?.streaming).toBeUndefined();

  expect(stream.feeds.at(-1)?.items.map(({ role }) => role)).toEqual([
    "user",
    "assistant",
  ]);

  stream.live({ type: "text", delta: "More" });
  stream.live({ type: "status", status: "idle", transcriptLength: 2 });

  expect(stream.feeds.at(-1)?.streaming).toBeUndefined();
});

test("a failed event stream is opened again until the session is gone", async () => {
  jest.useFakeTimers();
  const realFetch = globalThis.fetch;
  const statuses = [500, 502, 404];
  const lookups: string[] = [];

  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      lookups.push(input instanceof Request ? input.url : String(input));

      return Promise.resolve(
        new Response(null, { status: statuses.shift() ?? 404 }),
      );
    },
    { preconnect: realFetch.preconnect },
  );

  const streams: { url: string; fail: () => void }[] = [];

  const open = (url: string): EventStream => {
    const errors: (() => void)[] = [];

    const stream = {
      readyState: 0,
      CLOSED: 2,
      addEventListener: (type: string, listener: (event: never) => void) => {
        if (type === "error") {
          errors.push(listener as () => void);
        }
      },
      close: () => undefined,
    };

    streams.push({
      url,
      fail: () => {
        stream.readyState = 2;

        errors.forEach((listener) => {
          listener();
        });
      },
    });

    return stream;
  };

  const feeds: Feed[] = [];

  const reader = feedReader({
    dispatch: () => undefined,
    onChange: (feed) => feeds.push(feed),
    onSession: () => undefined,
  });

  const fail = async (): Promise<void> => {
    streams.at(-1)?.fail();

    for (let turn = 0; turn < 5; turn++) {
      await Promise.resolve();
    }

    jest.advanceTimersByTime(60_000);
  };

  try {
    followEvents("s 1", reader, open);
    await fail();
    await fail();

    expect(streams.map(({ url }) => url)).toEqual([
      "/api/sessions/s%201/events",
      "/api/sessions/s%201/events",
      "/api/sessions/s%201/events",
    ]);

    expect(feeds.some(({ missing }) => missing)).toBe(false);

    await fail();

    expect(streams).toHaveLength(3);

    expect(lookups).toEqual([
      "/api/sessions/s%201",
      "/api/sessions/s%201",
      "/api/sessions/s%201",
    ]);

    expect(feeds.at(-1)?.missing).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
    jest.useRealTimers();
  }
});

test("shows an extension's footer and header until it removes them or the stream reconnects", () => {
  const stream = connect();
  stream.live({ type: "footer", lines: ["main", "\x1b[32mok\x1b[39m"] });
  stream.live({ type: "header", lines: ["welcome"] });
  stream.live({ type: "header", lines: null });

  expect(stream.feeds.at(-1)).toMatchObject({
    footer: "main\n\x1b[32mok\x1b[39m",
    header: undefined,
  });

  stream.open();

  expect(stream.feeds.at(-1)?.footer).toBeUndefined();
});
