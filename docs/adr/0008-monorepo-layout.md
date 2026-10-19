# 0008: Monorepo layout

- Status: accepted
- Date: 2026-10-19

## Context

The repository is one Bun workspaces monorepo ([ADR 0003](0003-bun-runtime-and-workspaces.md)). [extensibility.md](../extensibility.md#possible-repository-module-map) sketches a module map with `core`, `sdk`, per-provider and `projects` packages, but leaves the layout open.

The first slice needs a CLI with `server` and `agent` commands, a web UI, a shared protocol, Session and attempt rules used by both server and agent, Workspace drivers ([ADR 0007](0007-session-workspaces.md)), a session host that v2 runs in its own pod ([ADR 0006](0006-provider-protocol.md)), and a Pi extension loaded into every hosted Session.

Five layouts were compared: apps and packages split by process, folders by where code runs, flat prefixed packages, one package with internal folders, and full domain slices. Process names like `control-plane` leave shared domain rules without a home. Full domain slices add a `core` grab bag, a `transport` layer package, and packages that stay empty until v2.

## Decision

Packages are named for what they provide, following Go package conventions:

```text
apps/                 thin entry points that wire packages together
  pi-cloud/           the binary: server and agent commands, SQLite and HTTP adapters
  web/                the browser UI
packages/             domain packages
  protocol/           the wire contract
  sessions/           Sessions, attempts, generation rules
  workspaces/         clone and worktree drivers
  providers/          work poll loop and the local and VM providers
  sessionhost/        runs one Pi session and streams it to the server
pi-extensions/        Pi packages loaded into hosted Sessions
  cloud-bridge/       mandatory: status, approvals and checkpoints
```

- Domain packages define the interfaces they need, such as a Session store or a Workspace driver. Apps supply the implementations.
- No `core`, `common`, `utils` or layer-named packages.
- A new package is added when a domain has code, not before. Expected next ones are `projects/`, `pi-extensions/cloud-projects/` and a Kubernetes provider.
- Pi extensions are ordinary Pi packages. The session host loads them by path, so they can be published later without moving.

## Consequences

- Domain rules shared by server and agent live in one place.
- The session host can become its own image in v2 without a split.
- Later extension points grow from the interfaces domain packages already define, which is where a public SDK would come from.
- The module map in extensibility.md stays a sketch; this layout replaces it for v1.
