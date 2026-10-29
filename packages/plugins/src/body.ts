import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { BadRequest, readJson } from "./http";

// The body as the schema types it, or a BadRequest that names the first field
// that doesn't fit, such as "name must be string".
export async function readBody<const Schema extends TSchema>(
  request: Request,
  schema: Schema,
): Promise<Static<Schema>> {
  const body = await readJson(request);

  if (Value.Check(schema, body)) {
    return body;
  }

  const [error] = Value.Errors(schema, body);
  const field = error?.instancePath.slice(1).replaceAll("/", ".") ?? "";

  throw new BadRequest(
    `${field === "" ? "body" : field} ${error?.message ?? "doesn't fit"}`,
  );
}
