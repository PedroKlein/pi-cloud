import { expect, test } from "bun:test";
import {
  BadRequest,
  fieldsOf,
  NotFound,
  readJson,
  requireAdmin,
} from "@pipoca/plugins";
import { fakeSession, fakeUser } from "@pipoca/plugins/testing";

const post = (body: string): Request =>
  new Request("http://plugin/items", { method: "POST", body });

test("reads a JSON body", async () => {
  expect(await readJson(post('{"name":"a"}'))).toEqual({ name: "a" });
});

test("refuses a body that isn't JSON as a bad request", async () => {
  const refused = await readJson(post("{not json")).catch(
    (error: unknown) => error,
  );

  expect(refused).toBeInstanceOf(BadRequest);
  expect(refused).toMatchObject({ status: 400, message: "body must be JSON" });
});

test("gives a body's fields, or none when it isn't an object", () => {
  expect(fieldsOf({ name: "a" })).toEqual({ name: "a" });
  expect(fieldsOf(null)).toEqual({});
  expect(fieldsOf(["a"])).toEqual({});
  expect(fieldsOf("a")).toEqual({});
});

test("carries the status the server answers with", () => {
  expect(new NotFound("no item 7")).toMatchObject({
    status: 404,
    message: "no item 7",
  });
});

test("lets only an admin through to a route that changes shared config", () => {
  const session = fakeSession();

  expect(() => {
    requireAdmin(fakeUser({ admin: true }), "only admins change names");
  }).not.toThrow();

  for (const caller of [
    fakeUser(),
    { kind: "session", session, actor: `session:${session.id}` } as const,
  ]) {
    expect(() => {
      requireAdmin(caller, "only admins change names");
    }).toThrow(
      expect.objectContaining({
        status: 403,
        message: "only admins change names",
      }),
    );
  }
});
