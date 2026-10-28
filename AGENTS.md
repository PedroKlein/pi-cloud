# AGENTS.md

Pipoca is a self-hosted control plane for durable Pi sessions and Projects on your own machines. Start with [README.md](README.md) and [docs/guide.md](docs/guide.md), then [docs/vision.md](docs/vision.md) for scope and [docs/adr/](docs/adr/) for decisions.

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
apps/            thin entry points: the pipoca binary (with its adapters) and web
packages/        domain packages: protocol, sessions, workspaces, providers, sessionhost
plugins/         features built on the kernel, such as projects (ADR 0015)
```

- Name packages for what they provide. No `core`, `common`, `utils` or layer-named packages.
- Domain packages define the interfaces they need. Apps supply the implementations.
- Add a package when a domain has code, not before.
- Keep exported surfaces narrow. Don't export something only so a test can reach it.

## Design

- Prefer deep modules: a lot of behavior behind a small interface. If deleting a module would only remove a pass-through, it shouldn't exist.
- Accept dependencies instead of creating them, and return results instead of producing side effects where you can.
- One adapter is a hypothetical seam, and two adapters make a real one. Don't add an interface until something actually varies across it.
- Make the smallest correct change. Reuse existing code, then the platform and standard library, then installed dependencies. Add dependencies or abstractions only for a demonstrated need.
- Fix root causes in the shared path, not symptoms at each caller. No unrelated refactors.

## Code

- Write simple, direct code. Prefer plain functions and data over clever abstractions.
- Almost no comments. Comment only non-obvious reasons, external constraints or spec links. If a comment explains what the code does, rewrite the code.
- Lint and type rules are strict on purpose: see `eslint.config.js` (typescript-eslint strict and stylistic type-checked rules) and `tsconfig.base.json`. Read them first.
- Use TypeScript's own tools for modeling: discriminated unions, `as const`, `satisfies` and `readonly` types. No enums, namespaces or default exports; the configs enforce this.
- Prettier formats everything with its defaults. Don't add options to it.
- Separate logical steps with blank lines. Lint requires them before `return`, after blocks and around multi-line statements, and `eslint --fix` adds them.
- TypeScript stays on 6.x until typescript-eslint supports 7.
- Fix the code instead of suppressing warnings. An inline suppression needs a reason, and blanket exclusions are not allowed.
- Long-running processes log timestamped progress (items scanned and processed, errors with identifiers, final counts), so a stuck job can be debugged from its log alone.

## Tests

- Test observable behavior through public interfaces. A test that breaks on a refactor that doesn't change behavior is testing the wrong thing.
- Mock only at system boundaries: HTTP, database, filesystem and processes.
- Work in vertical slices: one failing test, the code to pass it, then the next. Don't write all the tests first.
- Bugs: reproduce with the exact reported command first. Then write a test that fails because of the bug, fix it, and keep the test. No test, no fix, unless an existing test already covers that exact failure (say which one).
- Web UI follows [docs/design-system.md](docs/design-system.md): tokens and `@pipoca/ui` components, no hex colours, no bare `<select>` or file input.
- A bug in the web UI gets its test in `apps/pipoca/src/web.e2e.ts` (`bun run test:e2e`) when it shows only in a browser: focus, keys, layout or a phone viewport.
- Tests that open Pi's own terminal UI need `fd` on `PATH`. Without it Pi tries to download `fd` at startup, and offline the test times out.

## Done means evidence

- A claim that something works isn't evidence. Before calling work done, show output a reviewer can check against the current commit: test results with their assertions, a command transcript, or a screenshot of running behavior.
- Run `bun run format`, build, `bun run lint` (zero warnings), `bun run typecheck` and `bun test` before calling work done, plus `bun run test:e2e` when the web UI changed.
- When you claim a metric passed, pair it with one that's harder to game. For example, tests pass and no test changed in the same commit as the code it tests.

## Docs

- Record a decision as a new ADR (context, decision, consequences) and mark the matching item resolved in `docs/open-questions.md`.
- Write plainly: short sentences, no em dashes, no marketing words.

## Git and pull requests

- Conventional Commits for commit messages and PR titles, such as `docs(adr): ...` or `feat(sessions): ...`. PRs are squash-merged, so the PR title becomes the commit on main.
- Descriptive branch names, such as `feat/session-host` or `docs/adr-provider-protocol`.
- One concern per PR. Fix PRs stay minimal, with no bundled refactors.
- PR descriptions have a "Before:" paragraph, an "After:" paragraph and a short "How" paragraph, in plain language that reads like a person wrote it.
- Before calling a review done, run lint and read every comment on the PR.
- This repository is public. Commits, PR descriptions, issues, comments and docs must not mention the tools or assistants used to write them: no co-author trailers, session links, attribution lines or footers.
