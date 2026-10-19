# 0009: VM deployment and testing

- Status: accepted
- Date: 2026-10-19

## Context

In v1, `pi-cloud server` runs on a VM with a built-in VM provider, and `pi-cloud agent` runs on the laptop ([architecture](../architecture.md#v1-topology)). Both run Pi through the same `sessionhost` package ([ADR 0008](0008-monorepo-layout.md)). The laptop agent talks to the server over HTTP, and the VM provider calls the same interfaces in process ([ADR 0006](0006-provider-protocol.md)). Sessions on the VM work in a fresh clone, and laptop Sessions work in a worktree ([ADR 0007](0007-session-workspaces.md)).

Two things were still open: how the server is installed and kept running on the VM, and how we check that the system works without paying for a model on every run.

Sessions on the VM run git, Pi's tools and whatever the user's projects need, so they need a full dev machine around them. Claude Code's [self-hosted runner](https://code.claude.com/docs/en/self-hosted-environments) is also a process installed on a machine the user controls, and sessions use that machine's tools.

Pi's `@mariozechner/pi-ai` package ships a faux provider (`registerFauxProvider`). It is a real Pi model provider that answers with scripted messages, can stream them token by token, and can make tool calls.

## Decision

### Deployment

- The server runs natively on the VM as one Bun binary built with `bun build --compile`, under a systemd unit that restarts it on failure.
- Sessions use the VM's own git, toolchain and Pi login. Pi Cloud doesn't install them.
- The server binds to localhost, and the laptop reaches it through an SSH tunnel ([ADR 0005](0005-v1-access-and-model-credentials.md)). The agent on the laptop runs the same way, under the user's own service manager or by hand.
- There is no container image in v1.

### Testing

- Automated tests run Pi through its SDK with the faux provider. They need no network and no API key, and they give the same result every run. The model is a system boundary, so this is the only place Pi is faked.
- The whole flow runs on one machine: `pi-cloud server` and `pi-cloud agent` both on the laptop, with the agent pointed at `localhost`. This covers the protocol, the session host and the web UI. The real VM is needed only to check deployment and the laptop-offline cases.
- Each slice ends with a manual smoke test against a real model, using whatever Pi login that provider already has.
- CI runs `bun run format:check`, `bun run lint`, `bun run typecheck` and `bun test` on every PR. It is added with the first package, because `tsc` and `bun test` fail on an empty repository.

## Consequences

- Installing on the VM means copying one binary, writing one unit file and logging in to Pi once. Updates replace the binary and restart the unit.
- Sessions get the full VM. That fits one trusted user in v1, and gives no isolation between Sessions and the host. Isolation modes, container images and Kubernetes stay in v2.
- The first slice must confirm that a compiled binary can still load Pi extensions and packages from disk. If it can't, the server runs from source with `bun` under the same unit.
- Faux-provider tests prove our code, not model behavior. A change in how a real model formats tool calls only shows up in the manual smoke test.
- CI needs no secrets.
