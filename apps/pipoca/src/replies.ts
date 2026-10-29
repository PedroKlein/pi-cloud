import type { Rejection, Result } from "@pipoca/sessions";

const rejectionStatus = {
  not_found: 404,
  stale_generation: 409,
  offline: 409,
  archived: 409,
  not_kept: 409,
  unknown_environment: 400,
  environment_exists: 409,
  unknown_profile: 400,
  not_movable: 409,
  unknown_entry: 400,
} as const satisfies Record<Rejection, number>;

export function reply(result: Result<unknown>, status: number): Response {
  if (!result.ok) {
    return Response.json(
      { error: result.reason },
      { status: rejectionStatus[result.reason] },
    );
  }

  return result.value === undefined
    ? new Response(null, { status })
    : Response.json(result.value, { status });
}

export function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}
