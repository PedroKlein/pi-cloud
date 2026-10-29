# 0047: API Errors and Removal

- Status: accepted
- Date: 2026-10-29

## Context

The server and plugins answered errors with `{ "error": string }`. The string was sometimes a code, such as `not_found`, and sometimes a sentence, such as `body must be JSON`. A client couldn't tell which: the web showed codes to people, and the sign-in page kept its own table to turn codes into sentences. A thrown `HttpError` had only a status and a message, so a plugin couldn't give a code a client could check.

Plugin routes also removed things in two ways. The server's own API used `DELETE`, such as `DELETE /api/plugins/<id>`, while plugins used `POST providers/<id>/remove`, `POST disconnect` or `POST remove` with the key in the body.

Other APIs keep the code and the message apart. Stripe answers `{ "error": { "type", "code", "message" } }` ([Stripe errors](https://docs.stripe.com/api/errors)). GitHub's REST API removes with `DELETE` on the resource's own path ([GitHub REST API](https://docs.github.com/en/rest)).

## Decision

- Every error the server answers, from its own routes and from plugin routes, has the body `{ "error": "<code>", "message": "<message>" }` (decided 2026-10-29). The code is a stable snake_case string a program checks, such as `not_found`, `bad_request`, `forbidden`, `conflict`, or a more specific one such as `signed_out` or `busy`. The message is the text a person reads. A reply may add fields, such as `sessions` on a refused restart.
- `error` stays a top-level string, unlike Stripe, so a client that read `error` before still gets a string.
- `new HttpError(status, message, code?)` takes a code, which defaults to one for its status, such as `not_found` for 404. `BadRequest` and `NotFound` default to `bad_request` and `not_found`, and `requireAdmin` throws `admin_only`. An error from an SDK copy without codes gets the default for its status.
- `ok()` and `json()` in `@pipoca/plugins/web` reject with the message, falling back to the code, then to the status line. The code is the error's `cause`.
- Plugin routes remove things with `DELETE` on the thing's path, such as `DELETE providers/<id>`, not `POST providers/<id>/remove` (decided 2026-10-29).

## Consequences

- People read sentences in the web instead of codes, and the server writes them in one place.
- Plugins throw the SDK's errors instead of building error bodies, so their errors have the same shape as the server's.
- A client that compared `error` to a sentence now gets a code there. Clients in this repository read `message` instead.
- A key in a `DELETE` path, such as an issuer URL, is encoded with `encodeURIComponent` and decoded by the route.
