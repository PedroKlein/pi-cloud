// Thrown from a route, the server answers it with its status and
// { error: message }, as it does for its own routes.
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class BadRequest extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

export class NotFound extends HttpError {
  constructor(message: string) {
    super(404, message);
  }
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BadRequest("body must be JSON");
  }
}

export function isObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A body's fields, or none when it isn't an object, for each field to check.
export function fieldsOf(value: unknown): Readonly<Record<string, unknown>> {
  return isObject(value) ? value : {};
}
