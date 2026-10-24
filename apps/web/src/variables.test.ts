import { expect, test } from "bun:test";
import { variablesOf, variablesText } from "./variables";

test("reads and writes variables as NAME=value lines", () => {
  const variables = variablesOf("A=1\n\n B = x=y\nEMPTY=\n");

  expect(variables).toEqual({ A: "1", B: " x=y", EMPTY: "" });
  expect(variablesText({ A: "1", B: "two" })).toBe("A=1\nB=two");
  expect(() => variablesOf("NOEQUALS")).toThrow("isn't NAME=value");
});
