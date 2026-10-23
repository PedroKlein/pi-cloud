import { expect, test } from "bun:test";
import { ok } from "./index";

test("ok accepts an empty success and rejects with the server's error", async () => {
  const empty = new Response(null, { status: 204 });

  expect(await ok(Promise.resolve(empty))).toBe(empty);

  const refused = Response.json({ error: "unknown state" }, { status: 400 });

  expect(await ok(Promise.resolve(refused)).catch(String)).toBe(
    "Error: unknown state",
  );
});
