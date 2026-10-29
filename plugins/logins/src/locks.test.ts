import { expect, test } from "bun:test";
import { type Locks, locks } from "./locks";

async function leased(table: Locks, key: string): Promise<string> {
  const lease = await table.acquire(key);
  if (lease === undefined) {
    throw new Error(`${key} stayed held`);
  }

  return lease;
}

test("a waiter gets the key once its holder lets go", async () => {
  const table = locks(1000, 1000);
  const first = await leased(table, "k");

  const second = leased(table, "k");
  expect(table.release("k", first)).toBe(true);

  expect(table.holds("k", await second)).toBe(true);
});

test("a holder that never lets go loses the key", async () => {
  const table = locks(20, 1000);
  const first = await leased(table, "k");

  await leased(table, "k");

  expect(table.holds("k", first)).toBe(false);
  expect(table.release("k", first)).toBe(false);
});

test("a waiter gives up when the key stays held", async () => {
  const table = locks(1000, 20);
  await leased(table, "k");

  expect(await table.acquire("k")).toBeUndefined();
});

test("keys don't wait on each other", async () => {
  const table = locks(1000, 20);
  await leased(table, "a");

  expect(await table.acquire("b")).toBeDefined();
});
