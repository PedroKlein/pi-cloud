import { expect, test } from "bun:test";
import type { PluginRoute } from "./plugin";
import { fakeContext, fakeSession, memoryStore } from "./testing";

test("a memory store keeps rows and seals nothing", () => {
  const store = memoryStore();

  store.exec("create table greeter_names (name text)");
  store.run("insert into greeter_names values (?)", "Ana");

  expect(store.all("select name from greeter_names")).toEqual([
    { name: "Ana" },
  ]);

  expect(store.open(store.seal("secret", "row-1"), "row-1")).toBe("secret");
});

test("a fake context uses the members a test passes and names the ones it didn't", () => {
  let route: PluginRoute | undefined;

  const context = fakeContext({
    routes: {
      handle: (handler) => {
        route = handler;
      },
    },
  });

  context.routes.handle(() => new Response("hi"));
  context.changes.publish("names");
  context.log("registered");

  expect(route).toBeDefined();
  expect(context.settings.get()).toEqual({});

  expect(() => context.sessions.get("session-1")).toThrow(
    "sessions.get is not faked; pass it to fakeContext",
  );
});

test("a fake context's events reach their listeners", () => {
  const context = fakeContext();
  const heard: string[] = [];

  context.events.subscribe("greeter.Greeted", (event) => {
    heard.push(event.type);
  });

  context.events.publish({ type: "greeter.Greeted" });

  expect(heard).toEqual(["greeter.Greeted"]);
});

test("a fake Session takes the fields a test sets", () => {
  expect(fakeSession({ status: "running" })).toMatchObject({
    id: "session-1",
    status: "running",
    archivedAt: null,
  });
});
