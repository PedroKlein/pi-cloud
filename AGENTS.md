# AGENTS.md

Pi Cloud is a self-hosted control plane for durable Pi sessions and Projects on your own machines. Start with [README.md](README.md), then [docs/vision.md](docs/vision.md) for scope and [docs/adr/](docs/adr/) for decisions.

## Where things stand

- v1 is a laptop and one VM, with no Kubernetes ([vision](docs/vision.md#scope)). Don't build v2 features (Kubernetes, isolation modes, public SDK) early.
- Accepted decisions live in `docs/adr/NNNN-title.md`. Open ones live in [docs/open-questions.md](docs/open-questions.md). Don't treat a working assumption in another doc as decided.
- Claude Code (cloud sessions, self-hosted runners, Remote Control, Projects) is the main reference design. When you make a design choice, compare it with how Claude Code does the same thing and cite the docs.

## Stack

- TypeScript everywhere, on Bun: runtime, package manager, workspaces and test runner ([ADR 0002](docs/adr/0002-typescript-for-all-components.md), [ADR 0003](docs/adr/0003-bun-runtime-and-workspaces.md)).
- Prefer `node:*` APIs over `Bun.*` where both exist.
- SQLite on the server is the only store. Don't add brokers or other infrastructure without an ADR.

## Layout

[ADR 0008](docs/adr/0008-monorepo-layout.md):

```text
apps/            thin entry points: the pi-cloud binary (with its adapters) and web
packages/        domain packages: protocol, sessions, workspaces, providers, sessionhost
pi-extensions/   Pi packages loaded into hosted sessions, such as cloud-bridge
```

- Name packages for what they provide. No `core`, `common`, `utils` or layer-named packages.
- Domain packages define the interfaces they need. Apps supply the implementations.
- Add a package when a domain has code, not before.
- Keep exported surfaces narrow. Don't export something only so a test can reach it.

## Code

- Make the smallest correct change and reuse what exists first.
- No comments by default. Comment only non-obvious reasons, external constraints or spec links.
- Test behavior through public interfaces, and mock only at system boundaries (HTTP, database, filesystem). A bug fix comes with a test that fails before it.
- Long-running processes log timestamped progress with identifiers, so a stuck job can be debugged from its log.
- Before calling work done: format, lint with zero issues, typecheck and test.

## Docs

- Record a decision as a new ADR (context, decision, consequences) and mark the matching item resolved in `docs/open-questions.md`.
- Write plainly: short sentences, no em dashes, no marketing words.

## Git and pull requests

- Conventional Commits for commit messages and PR titles, such as `docs(adr): ...` or `feat(sessions): ...`. PRs are squash-merged, so the PR title becomes the commit on main.
- Descriptive branch names, such as `feat/session-host` or `docs/adr-provider-protocol`.
- One concern per PR.
- PR descriptions have a "Before:" paragraph, an "After:" paragraph and a short "How" paragraph, in plain language.
- This repository is public. Commits, PR descriptions, issues, comments and docs must not mention the tools or assistants used to write them: no co-author trailers, session links, attribution lines or footers.
