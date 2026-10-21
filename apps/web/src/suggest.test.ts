import { expect, test } from "bun:test";
import { complete, ranked, trigger } from "./suggest";

test("opens commands only for a slash at the start of the message", () => {
  expect(trigger("/rev", 4)).toEqual({
    kind: "command",
    query: "rev",
    from: 0,
  });

  expect(trigger("/", 1)).toEqual({ kind: "command", query: "", from: 0 });
  expect(trigger("/review now", 11)).toBeUndefined();
  expect(trigger("see /rev", 8)).toBeUndefined();
});

test("opens files for an @ word under the caret", () => {
  expect(trigger("read @src/ma", 12)).toEqual({
    kind: "file",
    query: "src/ma",
    from: 5,
  });

  expect(trigger("@", 1)).toEqual({ kind: "file", query: "", from: 0 });
  expect(trigger("mail me@home", 12)).toBeUndefined();
  expect(trigger("read @src done", 14)).toBeUndefined();
});

test("ranks prefix matches first, then other matches, and drops the rest", () => {
  expect(
    ranked(["skill:review", "review", "preview", "deploy"], "rev", (x) => x),
  ).toEqual(["review", "skill:review", "preview"]);

  expect(ranked(["b", "a"], "", (x) => x)).toEqual(["b", "a"]);
});

test("replaces the typed word with the pick and a trailing space", () => {
  expect(complete("read @src/ma please", 12, 5, "@src/main.ts")).toEqual({
    text: "read @src/main.ts please",
    caret: 18,
  });

  expect(complete("/rev", 4, 0, "/review")).toEqual({
    text: "/review ",
    caret: 8,
  });
});
