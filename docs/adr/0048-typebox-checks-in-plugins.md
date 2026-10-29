# 0048: TypeBox Checks in Plugins

- Status: accepted
- Date: 2026-10-29

## Context

Plugins checked request bodies by hand. A route read the body with `readJson`, took its fields with `fieldsOf`, and tested each one with `typeof` and `isObject`, about 90 checks across the built-in plugins. Each check wrote its own message, and the type of the body was a cast or a guess, so the check and the type could drift apart. The host checked plugin manifests and setting definitions the same way.

Pi checks a tool's parameters with a [TypeBox](https://github.com/sinclairzx81/typebox) schema. One schema gives the parameters' TypeScript type, through `Static`, and the JSON Schema the model sees, and Pi checks the model's arguments against it before the tool runs (Pi's `docs/extensions.md`). Pipoca already has TypeBox through Pi. Claude Code's Agent SDK does the same with Zod: a custom tool's input schema gives both its type and its check ([custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)).

## Decision

- Plugins check manifests, settings and request bodies with TypeBox schemas, like Pi's tool parameters, instead of hand-written checks (decided 2026-10-29).
- `readBody(request, schema)` from `@pipoca/plugins` reads a JSON body and checks it against a schema. It returns the body with the schema's type, or throws a `BadRequest` that names the first field that doesn't fit, in TypeBox's words, such as `name must be string`.
- `@pipoca/plugins` exports TypeBox's `Type` and `Static`, so an installed plugin builds its schemas with the server's copy ([ADR 0046](0046-plugin-sdk-from-the-server.md)).
- A schema checks shapes and types. A check that needs more than the value, such as whether a host is listed or a name is taken, stays in the route with its own message.

## Consequences

- A route's body has one source for its type and its check.
- Error messages for a body of the wrong shape use TypeBox's wording, which is plainer than a hand-written sentence but names the field.
- `readJson`, `isObject` and `fieldsOf` stay in the SDK for plugins that use them. Removing them would need a new `engine`.
