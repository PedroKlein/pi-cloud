import { expect, test } from "bun:test";
import { settingsOf } from "./plugin-settings";

test("reads each setting from the form by its type", () => {
  const form = new FormData();
  form.set("limit", "12");
  form.set("loud", "on");
  form.set("mode", "slow");
  form.set("greeting", " hi ");
  form.set("tags", "a\r\n\n b \n");

  expect(
    settingsOf(
      {
        limit: { type: "number", title: "Limit", default: 10 },
        loud: { type: "boolean", title: "Loud", default: false },
        quiet: { type: "boolean", title: "Quiet", default: true },
        mode: {
          type: "choice",
          title: "Mode",
          options: ["fast", "slow"],
          default: "fast",
        },
        greeting: { type: "string", title: "Greeting", default: "" },
        tags: { type: "strings", title: "Tags", default: [] },
      },
      form,
    ),
  ).toEqual({
    limit: 12,
    loud: true,
    quiet: false,
    mode: "slow",
    greeting: " hi ",
    tags: ["a", "b"],
  });
});
