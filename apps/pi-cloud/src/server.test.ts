import { expect, test } from "bun:test";
import { Sessions } from "@pi-cloud/sessions";
import { createHandler } from "./server";
import { openStore } from "./store";

test("reports unhealthy when the database can't be read", async () => {
  const store = openStore(":memory:");

  const handler = createHandler(
    new Sessions(store),
    store.check,
    () => undefined,
  );

  store.close();

  const response = await handler(new Request("http://127.0.0.1/healthz"));

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ status: "unavailable" });
});
