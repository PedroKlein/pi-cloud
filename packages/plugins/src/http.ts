import type { RouteCaller } from "./plugin";

// Every copy of this module brands its errors alike, so the server answers
// one thrown from a plugin that bundles its own copy too (ADR 0046).
const brand = Symbol.for("pipoca.http-error");

const codes: Readonly<Partial<Record<number, string>>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "too_large",
  429: "too_many_requests",
  500: "internal",
  503: "unavailable",
};

// Thrown from a route, the server answers it with its status and
// { error: code, message }, as it does for its own routes (ADR 0047). The
// code defaults to one for the status, such as not_found for 404.
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code ?? codes[status] ?? "error";
    Object.defineProperty(this, brand, { value: true });
  }
}

// Also true of an error from another copy of this module.
export function isHttpError(error: unknown): error is HttpError {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, brand) === true
  );
}

export class BadRequest extends HttpError {
  constructor(message: string, code?: string) {
    super(400, message, code);
  }
}

export class NotFound extends HttpError {
  constructor(message: string, code?: string) {
    super(404, message, code);
  }
}

// For a route that changes config every user shares (ADR 0038). The
// message is what the user who isn't an admin reads.
export function requireAdmin(caller: RouteCaller, message: string): void {
  if (caller.kind !== "user" || !caller.admin) {
    throw new HttpError(403, message, "admin_only");
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
