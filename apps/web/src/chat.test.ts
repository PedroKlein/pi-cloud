import { expect, test } from "bun:test";
import { chatItems, describeTool, linkParts, turns } from "./chat";

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
      answer: ["Fixed."],
    },
    { key: 7, user: "thanks", work: [], answer: [] },
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
