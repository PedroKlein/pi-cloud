import { expect, test } from "bun:test";
import { reviewMessage } from "./comments";

test("ties each comment to its file and line", () => {
  expect(
    reviewMessage([
      {
        checkout: "",
        path: "src/auth.ts",
        line: 47,
        removed: false,
        text: "don't catch here ",
      },
      {
        checkout: "api",
        path: "main.go",
        line: 3,
        removed: true,
        text: "keep this",
      },
    ]),
  ).toBe(
    [
      "Comments on the diff:",
      "",
      "- At `src/auth.ts:47`: don't catch here",
      "- At `api/main.go:3` (removed line): keep this",
    ].join("\n"),
  );
});
