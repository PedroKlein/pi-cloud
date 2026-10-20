# 0012: Built-in provider and clone Workspaces

- Status: accepted
- Date: 2026-10-20

## Context

[ADR 0009](0009-vm-deployment-and-testing.md) has `pi-cloud server` on the VM run Sessions itself, through the same `sessionhost` package as the laptop agent. [ADR 0006](0006-provider-protocol.md) said this built-in provider "implements the same interfaces in process, without HTTP".

Doing that literally needs a second set of adapters: an in-process work channel, an in-process Session stream, and a way for the terminal broker to pair a browser WebSocket with something that isn't a socket. The laptop agent already does all of this over HTTP, and its tests cover it.

Claude Code's [self-hosted runner](https://code.claude.com/docs/en/self-hosted-environments) is a separate process on the user's machine that polls the control plane over HTTPS. It doesn't get a private path into the server.

[ADR 0007](0007-session-workspaces.md) gives each VM Session a fresh clone on its own branch, and says the server stores a `workspaceRef` rather than a path.

## Decision

### Built-in provider

- `pi-cloud server --provider <name>` also runs the agent loop for a provider with that name, in the same process, against the server's own loopback address. It is the same code the laptop runs with `pi-cloud agent`.
- This replaces the "in process, without HTTP" line of ADR 0006. Everything else in ADR 0006 applies to the built-in provider unchanged: polling, generations, transcript upload and terminals.
- The server stops its agent before it closes its listener, so the last transcript entries reach the store.
- Restarting the server interrupts the built-in provider's Sessions. They reload idle from their transcript, like a restarted laptop agent's.

### Workspaces

- A Session has a `workspace`: a `folder` with a path, or a `clone` with a repository and a branch.
- The server names the branch `pi-cloud/<first 8 characters of the Session id>` when the Session is created, so the UI can show it before the clone exists.
- The provider clones into `<data dir>/workspaces/<Session id>` and switches to that branch. It clones into a temporary directory first and renames it, so a failed clone leaves nothing behind.
- A later attempt of the same Session reuses the clone, with any uncommitted work in it.
- Git runs with `GIT_TERMINAL_PROMPT=0`. A clone that needs credentials the provider doesn't have fails instead of waiting for a prompt nobody can answer.
- A failed clone fails the Session's start, as ADR 0011 does for other start failures.
- Any provider can take either kind. The laptop agent uses folders today; worktrees from ADR 0007 come later.

## Consequences

- One provider implementation. A bug fixed for the laptop agent is fixed for the VM.
- The built-in provider pays for JSON over a loopback socket. At one VM that is not measurable.
- The built-in agent's requests pass the same localhost Host and Origin checks as a laptop agent's through the SSH tunnel.
- There is no repository mirror yet, so each clone downloads the whole repository. ADR 0007 allows adding one later.
- Clones stay on disk after a Session ends. Removing them waits for the retention decision.
