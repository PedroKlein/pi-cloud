# 0010: Session host on Bun

- Status: accepted
- Date: 2026-10-19

## Context

[ADR 0003](0003-bun-runtime-and-workspaces.md) put every component on Bun, on the condition that the first slice runs a Pi Session, one third-party Pi extension and an interactive terminal in the session host. [ADR 0009](0009-vm-deployment-and-testing.md) added that a binary built with `bun build --compile` must still load Pi extensions from disk.

Pi can be hosted two ways. The SDK (`createAgentSession`) runs an `AgentSession` in the host process with typed events. RPC mode runs `pi --mode rpc` as a child process and talks JSON over stdio. Pi's npm packages moved from `@mariozechner/*` to `@earendil-works/*`, and the old names are deprecated.

For terminals, Node has no PTY API. The usual library, `node-pty`, is a native addon. Bun has a PTY built into `Bun.spawn` through its `terminal` option.

## Decision

- The `sessionhost` package runs Pi through the SDK from `@earendil-works/pi-coding-agent`, pinned to an exact version.
- Extensions are passed to the session host as paths and loaded by Pi's own resource loader, together with whatever the agent directory already configures. A failed extension stops the Session from starting.
- Terminals use `Bun.spawn` with a PTY. `node-pty` is not used.

What was checked, on Bun 1.4.2 and Pi 1.3.0:

- A Session with the faux provider runs a turn that calls Pi's `bash` tool and writes its JSONL transcript.
- `pi-subagents` 0.79.1 loads from its npm package and registers its tools.
- A compiled binary loads `pi-subagents` and a TypeScript extension file outside any `node_modules`. Pi detects the compiled binary and serves its own packages to extensions from the binary.
- A PTY shell runs commands, follows resizes and reports its exit code. `node-pty` 1.1.0 fails under Bun with `ioctl(2) failed, EBADF` on its first resize.

All of these run as tests in `packages/sessionhost`.

## Consequences

- The runtime choice in ADR 0003 stands, and the Node fallback isn't needed.
- Tests drive the real SDK with the faux provider in the same process, with no child process to fake.
- An extension that crashes the process takes the host down with it. Whether each Session gets its own host process is decided with the agent, not here.
- Terminals depend on a Bun API, so moving the session host to Node would need a PTY library again.
- Pi upgrades are explicit version bumps. The SDK is a library, so a breaking change shows up in typecheck and tests.
