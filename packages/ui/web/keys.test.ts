import { expect, test } from "bun:test";
import { isComposing } from "./keys";

test("treats a keydown that commits an IME conversion as composing", () => {
  expect(isComposing({ keyCode: 13, nativeEvent: { isComposing: true } })).toBe(
    true,
  );

  expect(
    isComposing({ keyCode: 229, nativeEvent: { isComposing: false } }),
  ).toBe(true);

  expect(
    isComposing({ keyCode: 13, nativeEvent: { isComposing: false } }),
  ).toBe(false);
});
