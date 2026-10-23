import { expect, test } from "bun:test";
import { responseOrder } from "./responses";

test("a response older than the one shown is ignored", () => {
  const order = responseOrder();
  const first = order.send();
  const second = order.send();

  expect(order.accept(second)).toBe(true);
  expect(order.accept(first)).toBe(false);
});

test("overlapping responses that arrive in order are all shown", () => {
  const order = responseOrder();
  const first = order.send();
  const second = order.send();

  expect(order.accept(first)).toBe(true);
  expect(order.accept(second)).toBe(true);
});

test("responses to requests sent before a drop are ignored", () => {
  const order = responseOrder();
  const active = order.send();
  order.drop();
  const archived = order.send();

  expect(order.accept(active)).toBe(false);
  expect(order.accept(archived)).toBe(true);
});
