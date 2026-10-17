# 0006: Provider protocol

- Status: accepted
- Date: 2026-10-17

## Context

In v1, `pi-cloud server` runs on a VM with a built-in VM provider, and `pi-cloud agent` runs on the laptop and reaches the server through an SSH tunnel ([architecture](../architecture.md#v1-topology)). There is no application auth ([ADR 0005](0005-v1-access-and-model-credentials.md)). A Session stays on the provider it started on, and moving it is an explicit fork ([vision](../vision.md#scope)).

The protocol has to cover three things: how the agent and server talk, who may run a Session at any moment, and how the conversation gets off the provider so a reconnecting browser can replay it and a dead laptop doesn't lose it.

The architecture review flagged two gaps here: a provider that loses its lease must stop touching the Workspace, and the transcript lives only on the provider while a Session runs.

Claude Code is the main reference ([research](../research.md)). Its two remote modes map onto the v1 providers:

- The laptop matches [Remote Control](https://code.claude.com/docs/en/remote-control): the session runs on your machine, connects outbound, and the server stores the transcript to sync devices. If the laptop sleeps or the network drops, the session keeps running and reconnects on its own.
- The VM matches a [self-hosted cloud runner](https://code.claude.com/docs/en/self-hosted-environments): the runner polls outbound, each poll renews a lease of about 60 seconds, and the control plane stores the transcript. A lapsed lease requeues the Session on another runner, which works because each runner clones the repository fresh. v1 has one VM and keeps Workspaces on it, so it has nowhere to requeue to.

Because v1 Sessions are pinned to one provider, only that provider's agent can ever start an attempt for them. Two copies of a Session can't run on two machines in v1. The remaining duplicate risk is inside one machine: an old Pi process still running when the agent starts a new attempt.

## Decision

### Connection

- The agent opens one WebSocket to the server and keeps it open, reconnecting with backoff. Claude Code uses HTTPS polling plus server-sent events instead; one socket is simpler when both ends are ours. Everything goes over it: assignments, commands, transcript entries, live events, and terminal bytes.
- Messages are JSON, typed in the shared `protocol` package. The first message is a `hello` carrying the protocol version and the provider's configured name. The server rejects a version it doesn't support.
- The built-in VM provider implements the same interface in process, without a socket.

### Attempts and connection health

- Each run of a Session is an attempt with a generation number that only increases. Every message about a Session carries its generation, and the server drops messages from an older one.
- The agent heartbeats every 10 seconds. The server marks a provider offline after 30 seconds without one, and shows its Sessions as offline rather than interrupted.
- A Session keeps running while its provider is offline. On reconnect, the agent reports each running attempt and its generation, and the server accepts it if the generation is still current.
- An attempt ends as interrupted when its Pi process exits without settling: the agent crashed, was killed, or the machine rebooted. The agent never starts a new attempt for a Session while an older attempt's process is still alive.
- When the agent starts again, it opens a new attempt for each interrupted Session. The Session reloads from its transcript and waits idle with the interruption shown. Nothing that was running is re-run.

### Transcript replication

- Pi's JSONL file on the provider stays the authoritative transcript while the Session runs.
- The agent sends each new JSONL entry to the server with its line number. The server stores it and acknowledges the highest contiguous line.
- The JSONL file is the agent's outbox. After a reconnect, the agent resends from the server's last acknowledged line, so nothing extra is buffered.
- Browsers replay a Session from the server's copy, then follow live. Streaming text and tool progress are forwarded live but not stored; a reconnecting browser sees completed entries plus whatever is streaming at that moment.
- If a provider is lost for good, the server's copy is what a fork to another provider starts from.

### Commands

- Chat input, steering, abort, approval answers, and terminal input go browser to server to agent.
- While the provider is offline, the server rejects them and the UI says the provider is offline. Nothing is queued for later delivery.
- Terminal bytes are forwarded live only. They aren't stored or replayed.

## Consequences

- One socket per agent, no message broker, and SQLite on the server as the only store.
- A laptop that sleeps or loses Wi-Fi doesn't kill its Sessions. Its Sessions show as offline and catch up on wake.
- Duplicate execution is prevented by the agent's own process supervision plus the generation check, not by lease expiry. Kubernetes and provider pools in v2 can reschedule a Session elsewhere, so they need expiring leases with self-fencing, which returns as a decision then.
- Server storage grows with every transcript. Retention is not decided.
- Relies on Pi appending to its JSONL file rather than rewriting it. The first slice must confirm this, including across compaction and branching.
