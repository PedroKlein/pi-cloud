import { expect, test } from "bun:test";
import { ansiRuns } from "./ansi";

test("splits styled text into runs of one style", () => {
  expect(ansiRuns("\x1b[1;32mFOCUS\x1b[22m plan\x1b[0m done")).toEqual([
    { text: "FOCUS", style: { bold: true, fg: "#4e9a06" } },
    { text: " plan", style: { fg: "#4e9a06" } },
    { text: " done", style: {} },
  ]);
});

test("reads 256-colour and true-colour foregrounds and backgrounds", () => {
  expect(ansiRuns("\x1b[38;5;196ma\x1b[48;2;10;20;30mb\x1b[39;49mc")).toEqual([
    { text: "a", style: { fg: "rgb(255 0 0)" } },
    { text: "b", style: { fg: "rgb(255 0 0)", bg: "rgb(10 20 30)" } },
    { text: "c", style: {} },
  ]);
});

test("drops escape sequences other than styles", () => {
  expect(
    ansiRuns("\x1b]8;;https://x.dev\x07link\x1b]8;;\x07\x1b[2K \x1b[2;3mz"),
  ).toEqual([
    { text: "link", style: {} },
    { text: " ", style: {} },
    { text: "z", style: { dim: true, italic: true } },
  ]);
});
