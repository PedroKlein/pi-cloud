import { expect, test } from "bun:test";
import {
  ago,
  type ChatItem,
  chatItems,
  describeTool,
  duration,
  linkParts,
  tally,
  turns,
} from "./chat";

const line = (message: unknown): string =>
  JSON.stringify({ type: "message", id: "1", message });

test("shows user and assistant text", () => {
  expect(chatItems(line({ role: "user", content: "hi" }))).toEqual([
    { role: "user", text: "hi" },
  ]);

  expect(
    chatItems(
      line({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "hello" },
        ],
      }),
    ),
  ).toEqual([{ role: "assistant", text: "hello" }]);
});

test("keeps the images a user sent and drops unknown image types", () => {
  const png = { type: "image", mimeType: "image/png", data: "AAAA" };
  const svg = { type: "image", mimeType: "image/svg+xml", data: "BBBB" };

  const items = chatItems(
    line({ role: "user", content: [{ type: "text", text: "look" }, png, svg] }),
  );

  expect(items).toEqual([
    {
      role: "user",
      text: "look",
      images: [{ mimeType: "image/png", data: "AAAA" }],
    },
  ]);

  expect(turns(items.map((item, key) => ({ ...item, key })))).toEqual([
    {
      key: 0,
      user: "look",
      images: [{ mimeType: "image/png", data: "AAAA" }],
      work: [],
      cards: [],
      answer: [],
    },
  ]);
});

test("shows tool calls and their results", () => {
  expect(
    chatItems(
      line({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
      }),
    ),
  ).toEqual([
    { role: "tool", id: "t1", name: "bash", args: { command: "ls" } },
  ]);

  expect(
    chatItems(
      line({
        role: "toolResult",
        toolCallId: "t1",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "boom" }],
      }),
    ),
  ).toEqual([
    { role: "result", id: "t1", name: "bash", text: "boom", failed: true },
  ]);
});

test("shows a command the user ran in Pi as a bash step", () => {
  const ran = (exitCode: number | undefined, cancelled: boolean): string =>
    JSON.stringify({
      type: "message",
      id: "b1",
      message: {
        role: "bashExecution",
        command: "ls",
        output: "a.ts\n",
        exitCode,
        cancelled,
        truncated: false,
        timestamp: 1,
      },
    });

  const step = (failed: boolean): ChatItem[] => [
    { role: "user", text: "!ls" },
    { role: "tool", id: "b1", name: "bash", args: { command: "ls" } },
    { role: "result", id: "b1", name: "bash", text: "a.ts\n", failed },
  ];

  expect(chatItems(ran(0, false))).toEqual(step(false));
  expect(chatItems(ran(2, false))).toEqual(step(true));
  expect(chatItems(ran(undefined, true))).toEqual(step(true));
});

test("starts a new turn for a command the user ran in Pi, after the last answer", () => {
  const items = [
    line({ role: "user", content: [{ type: "text", text: "hi" }] }),
    line({ role: "assistant", content: [{ type: "text", text: "Hi!" }] }),
    line({
      role: "bashExecution",
      command: "echo x",
      output: "x\n",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1,
    }),
  ].flatMap(chatItems);

  expect(turns(items.map((item, key) => ({ ...item, key })))).toMatchObject([
    { user: "hi", work: [], answer: ["Hi!"] },
    {
      user: "!echo x",
      work: [
        { kind: "step", step: { name: "bash", args: { command: "echo x" } } },
      ],
      answer: [],
    },
  ]);
});

test("skips entries it cannot read instead of failing", () => {
  expect(chatItems(line({ role: "compactionSummary", summary: "s" }))).toEqual(
    [],
  );

  expect(chatItems("{not json")).toEqual([]);
});

test("shows a failed assistant turn", () => {
  expect(
    chatItems(
      line({ role: "assistant", content: [], errorMessage: "rate limited" }),
    ),
  ).toEqual([{ role: "error", text: "rate limited" }]);
});

test("skips entries that are not chat messages", () => {
  expect(chatItems(JSON.stringify({ type: "session", id: "s" }))).toEqual([]);
  expect(chatItems(line({ role: "system", content: "rules" }))).toEqual([]);
});

test("shows custom messages meant for display", () => {
  const custom = (display: boolean): string =>
    JSON.stringify({
      type: "custom_message",
      customType: "note",
      content: "thread finished",
      display,
    });

  expect(chatItems(custom(true))).toEqual([
    { role: "note", text: "thread finished" },
  ]);

  expect(chatItems(custom(false))).toEqual([]);
});

test("shows a custom message without the terminal colors an extension gave it", () => {
  const entry = JSON.stringify({
    type: "custom_message",
    customType: "todo",
    content: "\x1b[38;5;5mTODO\x1b[39m\n\x1b[1m- ship\x1b[22m",
    display: true,
  });

  expect(chatItems(entry)).toEqual([{ role: "note", text: "TODO\n- ship" }]);
});

test("describes a tool call as a verb and its object", () => {
  expect(describeTool("read", { path: "src/app.ts" })).toEqual({
    verb: "Read",
    object: "src/app.ts",
  });

  expect(describeTool("bash", { command: "bun test\nbun run lint" })).toEqual({
    verb: "Ran",
    object: "bun test",
  });

  expect(describeTool("start_thread", { title: "Docs" })).toEqual({
    verb: "start_thread",
    object: "Docs",
  });
});

test("groups a turn into its work and its answer", () => {
  const keyed = [
    { role: "user", text: "fix it" },
    { role: "assistant", text: "Looking." },
    { role: "tool", id: "a", name: "read", args: { path: "x.ts" } },
    { role: "result", id: "a", name: "read", text: "code", failed: false },
    { role: "tool", id: "b", name: "bash", args: { command: "bun test" } },
    { role: "result", id: "b", name: "bash", text: "1 fail", failed: true },
    { role: "assistant", text: "Fixed." },
    { role: "user", text: "thanks" },
  ].map(
    (item, key) => ({ ...item, key }) as Parameters<typeof turns>[0][number],
  );

  expect(turns(keyed)).toEqual([
    {
      key: 0,
      user: "fix it",
      work: [
        { kind: "narration", text: "Looking." },
        {
          kind: "step",
          step: {
            id: "a",
            name: "read",
            args: { path: "x.ts" },
            result: { text: "code", failed: false },
          },
        },
        {
          kind: "step",
          step: {
            id: "b",
            name: "bash",
            args: { command: "bun test" },
            result: { text: "1 fail", failed: true },
          },
        },
      ],
      cards: [],
      answer: ["Fixed."],
    },
    { key: 7, user: "thanks", work: [], cards: [], answer: [] },
  ]);
});

test("finds the URLs in a note, without the punctuation after them", () => {
  expect(
    linkParts("Enter the code AB-12 at https://github.com/login/device."),
  ).toEqual([
    { text: "Enter the code AB-12 at ", link: false },
    { text: "https://github.com/login/device", link: true },
    { text: ".", link: false },
  ]);

  expect(linkParts("No links here")).toEqual([
    { text: "No links here", link: false },
  ]);
});

test("times a turn from its message to its last entry and names the answering model", () => {
  const entries = [
    {
      type: "message",
      timestamp: "2026-10-22T10:00:00.000Z",
      message: { role: "user", content: "fix it" },
    },
    {
      type: "message",
      timestamp: "2026-10-22T10:00:30.000Z",
      message: {
        role: "assistant",
        model: "gpt-5.3-codex",
        content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
      },
    },
    {
      type: "message",
      timestamp: "2026-10-22T10:01:12.000Z",
      message: {
        role: "assistant",
        model: "gpt-5.3-codex",
        content: [{ type: "text", text: "done" }],
      },
    },
  ];

  const [turn] = turns(
    entries
      .flatMap((entry) => chatItems(JSON.stringify(entry)))
      .map((item, key) => ({ ...item, key })),
  );

  expect(turn).toMatchObject({
    started: "2026-10-22T10:00:00.000Z",
    ended: "2026-10-22T10:01:12.000Z",
    model: "gpt-5.3-codex",
    answer: ["done"],
  });

  expect(duration(turn?.started ?? "", turn?.ended ?? "")).toBe("1m 12s");
  expect(duration("2026-10-22T10:00:00Z", "2026-10-22T10:00:09Z")).toBe("9s");
});

test("ends a turn at Pi's last message, not at notes posted after it", () => {
  const entries = [
    {
      type: "message",
      timestamp: "2026-10-22T10:00:00.000Z",
      message: { role: "user", content: "fix it" },
    },
    {
      type: "message",
      timestamp: "2026-10-22T10:00:07.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    },
    {
      type: "custom_message",
      timestamp: "2026-10-22T10:01:21.000Z",
      customType: "todo",
      content: "board",
      display: true,
    },
  ];

  const [turn] = turns(
    entries
      .flatMap((entry) => chatItems(JSON.stringify(entry)))
      .map((item, key) => ({ ...item, key })),
  );

  expect(turn?.ended).toBe("2026-10-22T10:00:07.000Z");
});

test("keeps a turn's end when a live notice without a time joins it", () => {
  const items = [
    {
      type: "message",
      timestamp: "2026-10-22T10:00:00.000Z",
      message: { role: "user", content: "fix it" },
    },
    {
      type: "message",
      timestamp: "2026-10-22T10:00:06.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    },
  ].flatMap((entry) => chatItems(JSON.stringify(entry)));

  const [turn] = turns(
    [...items, { role: "error", text: "Login cancelled" } as const].map(
      (item, key) => ({ ...item, key }),
    ),
  );

  expect(turn?.ended).toBe("2026-10-22T10:00:06.000Z");
});

test("tallies a turn's work by kind of step", () => {
  const steps = ["read", "read", "edit", "write", "bash", "grep"].map(
    (name) => ({ name }),
  );

  expect(tally(steps)).toEqual([
    "read 2 files",
    "edited 2 files",
    "ran 1 command",
    "1 other step",
  ]);

  expect(tally([])).toEqual([]);
});

test("says how long ago an answer came", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");

  expect(ago("2026-10-22T11:59:30Z", now)).toBe("just now");
  expect(ago("2026-10-22T11:58:00Z", now)).toBe("2 min ago");
  expect(ago("2026-10-22T09:00:00Z", now)).toBe("3 h ago");
});

test("takes the tool calls a plugin draws out of the work, with their result details", () => {
  const keyed = [
    { role: "user", text: "delegate" },
    { role: "tool", id: "a", name: "read", args: { path: "x.ts" } },
    { role: "result", id: "a", name: "read", text: "code", failed: false },
    { role: "tool", id: "s", name: "subagent", args: { agent: "scout" } },
    {
      role: "result",
      id: "s",
      name: "subagent",
      text: "Async: scout",
      failed: false,
      details: { asyncId: "r1" },
    },
    { role: "tool", id: "t", name: "subagent", args: { agent: "worker" } },
  ].map(
    (item, key) => ({ ...item, key }) as Parameters<typeof turns>[0][number],
  );

  const [turn] = turns(keyed, (tool) => tool === "subagent");

  expect(turn?.work.map((item) => item.kind)).toEqual(["step"]);

  expect(turn?.cards).toEqual([
    {
      id: "s",
      name: "subagent",
      args: { agent: "scout" },
      result: {
        text: "Async: scout",
        failed: false,
        details: { asyncId: "r1" },
      },
    },
    { id: "t", name: "subagent", args: { agent: "worker" } },
  ]);
});

test("keeps a tool result's details", () => {
  expect(
    chatItems(
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "s",
          toolName: "subagent",
          content: [{ type: "text", text: "Async: scout" }],
          details: { asyncId: "r1" },
        },
      }),
    ),
  ).toEqual([
    {
      role: "result",
      id: "s",
      name: "subagent",
      text: "Async: scout",
      failed: false,
      details: { asyncId: "r1" },
    },
  ]);
});

test("opens a turn with a plugin's notice, and keeps an untagged one a note", () => {
  const notice = (details: unknown): string =>
    JSON.stringify({
      type: "custom_message",
      customType: "pipoca-notice",
      content: "Docs finished a turn",
      display: true,
      details,
    });

  const tag = { plugin: "projects", kind: "thread", data: { threadId: "t1" } };

  const items = [
    ...chatItems(notice(tag)),
    ...chatItems(line({ role: "assistant", content: "noted" })),
  ];

  expect(turns(items.map((item, key) => ({ ...item, key })))).toEqual([
    {
      key: 0,
      user: undefined,
      notice: { text: "Docs finished a turn", tag },
      work: [],
      cards: [],
      answer: ["noted"],
    },
  ]);

  expect(chatItems(notice({ kind: "thread" }))).toEqual([
    { role: "note", text: "Docs finished a turn" },
  ]);
});
