# 0046: Plugin SDK From the Server

- Status: accepted
- Date: 2026-10-29

## Context

Built-in plugins import `@pipoca/plugins` for their errors (`HttpError`, `BadRequest`, `NotFound`), body checks (`readJson`, `fieldsOf`) and admin check (`requireAdmin`). The package is a private workspace package, so an installed plugin couldn't import it: its server and Session parts are bundled from the plugin's own folder, and the package isn't on npm. [docs/plugins.md](../plugins.md) told outside authors to import only types, so they wrote their own errors and admin checks. Copying the error classes into a plugin didn't work either, since the server answers a thrown error with its status only when it is `instanceof` its own `HttpError`.

Web parts already avoid this. They get React, `@pipoca/ui` and `@pipoca/plugins/web` from the page they run in, through a global the shell sets ([ADR 0022](0022-plugin-model-v2.md#installing-third-party-plugins)).

Publishing `@pipoca/plugins` to npm would let a plugin pin a version, but the interface isn't frozen yet ([open questions](../open-questions.md#extension-system)), and a plugin's copy could drift from the server it runs on. Claude Code's plugins have no runtime library to import: they are commands, agents, hooks and MCP servers the host loads. VS Code is the closer match. Its extensions import the `vscode` module from the editor that runs them, and npm has only its types ([VS Code API](https://code.visualstudio.com/api/references/vscode-api)).

## Decision

- The running server provides `@pipoca/plugins` to installed plugins' server and Session parts (decided 2026-10-29). Their bundles leave that import out and read the module from a global the server and runner set before importing the part, as web parts do. Only the package's root, with its public exports, is provided.
- The SDK is versioned with the server. A plugin targets a server through `engine` in its manifest, as before.
- No npm package for now. Types and `@pipoca/plugins/testing` come from the Pipoca repository until the interface is frozen.
- `HttpError` and its subclasses carry a brand, `Symbol.for("pipoca.http-error")`, and `isHttpError(error)` from `@pipoca/plugins` checks it. The server and `served()` in `@pipoca/plugins/testing` use it, so an error from another copy of the module, such as one a plugin bundled itself, is answered like the server's own. `instanceof` works as usual within one copy.

## Consequences

- Outside authors throw `BadRequest`, `NotFound` and `HttpError` and call `requireAdmin` exactly as built-ins do, and the guide's example plugin does too.
- A plugin always gets the SDK of the server it runs on. A change to the SDK that breaks plugins needs a new `engine`.
- Authors outside the repository have no published types. A public, versioned SDK is still a v2 item ([vision](../vision.md#v2-execution-platform)).
