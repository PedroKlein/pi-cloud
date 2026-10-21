import { expect, test } from "bun:test";
import { chatItems } from "./chat";

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
  ).toEqual([{ role: "tool", text: 'bash {"command":"ls"}' }]);

  expect(
    chatItems(
      line({
        role: "toolResult",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "boom" }],
      }),
    ),
  ).toEqual([{ role: "error", text: "bash → boom" }]);
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
    { role: "tool", text: "thread finished" },
  ]);

  expect(chatItems(custom(false))).toEqual([]);
});
