import { expect, test } from "bun:test";
import type { SettingSpec } from "@pipoca/protocol";
import { checkedSettings, settingValues } from "@pipoca/plugins";

const schema: Readonly<Record<string, SettingSpec>> = {
  limit: { type: "number", title: "Limit", default: 10, min: 1, max: 100 },
  greeting: { type: "string", title: "Greeting", default: "hi" },
  loud: { type: "boolean", title: "Loud", default: false },
  mode: {
    type: "choice",
    title: "Mode",
    options: ["fast", "slow"],
    default: "fast",
  },
  tags: { type: "strings", title: "Tags", default: [] },
};

test("fills every setting it declares with a default", () => {
  expect(settingValues(schema, undefined)).toEqual({
    limit: 10,
    greeting: "hi",
    loud: false,
    mode: "fast",
    tags: [],
  });
});

test("reads stored values that fit and drops the rest", () => {
  expect(
    settingValues(schema, {
      limit: 500,
      greeting: "hello",
      loud: "yes",
      mode: "slow",
      tags: ["a", 1],
      gone: true,
    }),
  ).toEqual({
    limit: 10,
    greeting: "hello",
    loud: false,
    mode: "slow",
    tags: [],
  });
});

test("refuses a value that doesn't fit and names the setting", () => {
  expect(checkedSettings(schema, { limit: 0 })).toBe(
    "Limit must be a number, at least 1, at most 100",
  );

  expect(checkedSettings(schema, { mode: "medium" })).toBe(
    "Mode must be one of fast, slow",
  );

  expect(checkedSettings(schema, { tags: "a" })).toBe(
    "Tags must be a list of text",
  );

  expect(checkedSettings(schema, [])).toBe("settings must be an object");
});

test("saves what fits, with defaults for the settings left out", () => {
  expect(checkedSettings(schema, { limit: 20, tags: ["a"], gone: 1 })).toEqual({
    limit: 20,
    greeting: "hi",
    loud: false,
    mode: "fast",
    tags: ["a"],
  });
});
