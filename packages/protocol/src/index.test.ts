import { expect, test } from "bun:test";
import { checkoutName } from "./index";

test("names a checkout after the last segment of its URL", () => {
  expect(checkoutName("https://github.com/org/app.git")).toBe("app");
  expect(checkoutName("git@github.com:org/app.git")).toBe("app");
  expect(checkoutName("/home/me/app/")).toBe("app");
  expect(checkoutName("C:\\code\\app")).toBe("app");
});

test("gives no name to a URL whose last segment can't be a folder", () => {
  expect(checkoutName("/home/me/app/.git")).toBeUndefined();
  expect(checkoutName("/home/me/app/.git/")).toBeUndefined();
  expect(checkoutName("https://example.com/org/.")).toBeUndefined();
  expect(checkoutName("https://example.com/org/..")).toBeUndefined();
  expect(checkoutName("https://example.com/org/..git")).toBeUndefined();
});
