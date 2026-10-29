import { expect, test } from "bun:test";
import { BadRequest, readBody, Type } from "@pipoca/plugins";

const post = (body: string): Request =>
  new Request("http://plugin/items", { method: "POST", body });

const item = Type.Object({
  name: Type.String(),
  size: Type.Optional(Type.Number()),
  owner: Type.Optional(Type.Object({ id: Type.String() })),
});

const refusal = async (body: string): Promise<unknown> =>
  readBody(post(body), item).catch((error: unknown) => error);

test("reads a body that fits its schema", async () => {
  const body = await readBody(post('{"name":"a","size":2}'), item);

  expect(body).toEqual({ name: "a", size: 2 });
  expect(body.name.toUpperCase()).toBe("A");
});

test("refuses a body that doesn't fit, naming the field", async () => {
  expect(await refusal('{"size":2}')).toMatchObject({
    status: 400,
    code: "bad_request",
    message: "body must have required properties name",
  });

  expect(await refusal('{"name":7}')).toMatchObject({
    status: 400,
    message: "name must be string",
  });

  expect(await refusal('{"name":"a","owner":{"id":1}}')).toMatchObject({
    status: 400,
    message: "owner.id must be string",
  });

  expect(await refusal("[]")).toMatchObject({
    status: 400,
    message: "body must be object",
  });
});

test("refuses a body to check that isn't JSON", async () => {
  const refused = await refusal("{not json");

  expect(refused).toBeInstanceOf(BadRequest);
  expect(refused).toMatchObject({ status: 400, message: "body must be JSON" });
});
