import { expect, test } from "bun:test";
import { modified } from "./keys";

test("turns typed keys into control and alt sequences", () => {
  expect(modified("c", "ctrl")).toBe("\x03");
  expect(modified("D", "ctrl")).toBe("\x04");
  expect(modified("[", "ctrl")).toBe("\x1b");
  expect(modified("1", "ctrl")).toBe("1");
  expect(modified("ab", "ctrl")).toBe("ab");
  expect(modified("b", "alt")).toBe("\x1bb");
  expect(modified("x", undefined)).toBe("x");
});

test("adds the modifier to arrow keys as xterm does", () => {
  expect(modified("\x1b[D", "ctrl")).toBe("\x1b[1;5D");
  expect(modified("\x1b[A", "alt")).toBe("\x1b[1;3A");
  expect(modified("\x1b[C", undefined)).toBe("\x1b[C");
});
