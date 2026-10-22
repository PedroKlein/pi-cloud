# 0017: A process per Session

- Status: accepted, amended by [ADR 0027](0027-pi-tui-view.md) (the TUI view runs in the Session process on a virtual terminal)
- Date: 2026-10-21

## Context

[ADR 0011](0011-server-and-agent-processes.md) runs every Session inside the agent's own process. Its consequences already name the cost: a Pi extension that blocks the event loop or crashes the process affects every Session on that agent.

That cost grows with plugins. Each plugin's session part is a Pi extension loaded into hosted Sessions ([ADR 0015](0015-plugins.md)), on top of the user's own extensions.

A spike ran Pi's interactive TUI inside the agent. Quitting it calls `process.exit`, it adds its own signal handlers, and Ctrl+Z stops the whole process group. Changing Pi upstream isn't an option, so a TUI view of a Session needs that Session in its own process.

Claude Code's [self-hosted runner](https://code.claude.com/docs/en/self-hosted-environments) hosts several Sessions for its owner, each as a child process with its own directory ([research](../research.md#claude-self-hosted-environments)).

How a Runtime isolates Sessions in v2 (shared runner, dedicated pod, Job, hardened) stays open ([open questions](../open-questions.md#runtime-and-isolation)). A child process per Session fits any of them, because a shared runner runs its Sessions the same way.

## Decision

- The agent runs each Session in its own child process: `pi-cloud session <id>`, the same binary.
- The child runs `sessionhost` and opens the Session's transcript, event and command streams to the server itself. ADR 0011 already gives each Session its own streams, so the protocol doesn't change.
- The agent keeps the work poll, Workspace preparation, terminals and the model list. It starts a child when the server assigns a Session and stops it on archive.
- A child exits when its pipe to the agent closes. An agent crash still interrupts every Session it hosts, as [ADR 0004](0004-first-slice-and-provider-order.md) and [ADR 0006](0006-provider-protocol.md) expect, and no attempt outlives the agent that started it.
- A child that exits on its own interrupts only its Session. The agent reports it, and the Session reloads idle from its transcript, as after an agent restart.
- A child that fails to start marks the Session failed with the error, as ADR 0011 does today.
- Children are spawned with pipes. The TUI view draws on a virtual terminal inside the child, so it needs no PTY ([ADR 0027](0027-pi-tui-view.md)).
- This replaces ADR 0011's "There is no process per Session in v1". The rest of ADR 0011 stands.

## Consequences

- One Session's extension can no longer crash or block the others.
- Archiving a Session frees its memory by ending its process.
- Every live Session pays for its own Bun and Pi process, in memory and start time. Measured on the VM on 2026-10-21: 80 to 90 MB resident per Session process, and a new clone Session answered its first message 8 s after it was created.
- The built-in provider gets the same behaviour, since it runs the same agent code ([ADR 0012](0012-built-in-provider.md)).
- A TUI view of a Session becomes possible ([ADR 0027](0027-pi-tui-view.md)).
