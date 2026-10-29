import type { Rejection, Result } from "@pipoca/sessions";

const rejections = {
  not_found: [404, "Not found."],
  stale_generation: [409, "The Session has moved on since this was sent."],
  offline: [409, "The Session's runner is offline."],
  archived: [409, "The Session is archived."],
  not_kept: [409, "The Session has no kept workspace to remove."],
  unknown_environment: [400, "There is no such Environment."],
  environment_exists: [409, "An Environment of that name already exists."],
  unknown_profile: [400, "There is no such Profile."],
  not_movable: [
    409,
    "The Session's workspace can't move to another Environment.",
  ],
} as const satisfies Record<Rejection, readonly [number, string]>;

// Every error the API answers has this body: a code a program can check and
// the message a person reads (ADR 0047).
export function errorReply(
  status: number,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): Response {
  return Response.json({ ...details, error: code, message }, { status });
}

export function rejected(reason: Rejection): Response {
  const [status, message] = rejections[reason];

  return errorReply(status, reason, message);
}

export function reply(result: Result<unknown>, status: number): Response {
  if (!result.ok) {
    return rejected(result.reason);
  }

  return result.value === undefined
    ? new Response(null, { status })
    : Response.json(result.value, { status });
}

export function notFound(): Response {
  return rejected("not_found");
}
