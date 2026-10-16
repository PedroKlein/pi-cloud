# 0003: Bun runtime and workspaces

- Status: accepted
- Date: 2026-10-16

## Context

[ADR 0002](0002-typescript-for-all-components.md) chose TypeScript for every component but left the runtime and package manager open.

Pi runs under Bun: its release binaries are built with `bun build --compile` ([pi#2591](https://github.com/earendil-works/pi/issues/2591)), and [pi#6396](https://github.com/earendil-works/pi/issues/6396) reports that Pi itself runs fine under Bun. Pi's `install` and `update` commands still shell out to `npm` unless `npmCommand` is configured, which matters because Profiles install Pi packages.

Bun offers single-file executables for the Provider Agent, built-in SQLite, a test runner, and workspaces. Its risks are native addons such as `node-pty`, and libraries or user Pi extensions that are only tested against Node. Running some components on Node and others on Bun is uncommon and doubles the test and release surface.

## Decision

All components run on Bun. The repository is one monorepo using Bun workspaces, Bun's package manager, and Bun's test runner.

Code uses `node:*` APIs over `Bun.*` APIs where both exist, so a component can move to Node if it has to.

The first end-to-end slice must run a Pi Session, one third-party Pi extension, and an interactive terminal inside the Session host on Bun. If that fails, the runtime choice is revisited in a new ADR.

## Consequences

- One runtime, one package manager, and one test runner across the repository.
- The Provider Agent can ship as a single executable.
- Hosted Sessions configure Pi's `npmCommand` for Bun until Pi infers it.
- A Bun incompatibility in the Session host is the main known risk, and the first slice is designed to surface it early.
