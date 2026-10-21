# 0006: Provider protocol

- Status: accepted, built-in provider transport amended by [ADR 0012](0012-built-in-provider.md), amended 2026-10-21 (composer input: images, slash commands, file mentions)
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

The protocol follows Claude Code's shape: a work channel per provider and a stream per Session, all plain HTTP.

- **Work channel.** The agent long-polls the server over HTTPS for new assignments and commands like "start" or "stop this Session". Each poll waits up to about 10 seconds. A failed poll is retried with backoff up to 20 seconds.
- **Session stream.** The Session host opens its own stream for each Session. Transcript entries and live events go up as HTTPS POSTs, and chat input, steering, abort and approval answers come down over server-sent events (SSE). Session traffic doesn't go through the work channel, so in v2 a Session in its own pod talks to the server the same way.
- **Terminal.** Each open terminal gets its own WebSocket between the Session host and the server, because keystrokes need low latency in both directions.
- Bodies are JSON, typed in the shared `protocol` package. Every request carries the protocol version and the provider's configured name, and the server rejects a version it doesn't support.
- The built-in VM provider implements the same interfaces in process, without HTTP. (Replaced by [ADR 0012](0012-built-in-provider.md): it runs the same agent over loopback HTTP.)

### Attempts and connection health

- Each run of a Session is an attempt with a generation number that only increases. Every message about a Session carries its generation, and the server drops messages from an older one.
- Each poll doubles as the provider's heartbeat. The server marks a provider offline after 30 seconds without a poll, and shows its Sessions as offline rather than interrupted.
- A Session keeps running while its provider is offline. When polls resume, the agent reports each running attempt and its generation, and the server accepts it if the generation is still current.
- An attempt ends as interrupted when its Pi process exits without settling: the agent crashed, was killed, or the machine rebooted. The agent never starts a new attempt for a Session while an older attempt's process is still alive.
- When the agent starts again, it opens a new attempt for each interrupted Session. The Session reloads from its transcript and waits idle with the interruption shown. Nothing that was running is re-run.

### Transcript replication

- Pi's JSONL file on the provider stays the authoritative transcript while the Session runs.
- The Session host POSTs each new JSONL entry to the server with its line number. The server stores it and answers with the highest contiguous line it has.
- The JSONL file is the outbox. After a failure, the Session host resends from the server's last acknowledged line, so nothing extra is buffered, and a repeated POST is harmless.
- Browsers replay a Session from the server's copy, then follow live. Streaming text and tool progress are forwarded live but not stored; a reconnecting browser sees completed entries plus whatever is streaming at that moment.
- If a provider is lost for good, the server's copy is what a fork to another provider starts from.

### Commands

- Chat input, steering, abort and approval answers go from the browser to the server, then down the Session's SSE stream. Terminal input goes over the terminal's WebSocket.
- While the provider is offline, the server rejects them and the UI says the provider is offline. Nothing is queued for later delivery.
- Terminal bytes are forwarded live only. They aren't stored or replayed.

### Composer input

Added 2026-10-21. The composer takes images, slash commands and `@` file mentions, like Claude Code's and Pi's own editor. Each one maps onto something Pi already does, so the protocol only carries data and Pi does the work.

- **Images.** The `message` command gains an optional `images` list of `{ mimeType, data }`, with `data` in base64. The Session host passes them to Pi's `prompt(text, { images })`, so they reach the model as image content and land in the JSONL entry for that message. They replicate with the transcript like any other entry, and the chat view shows them from there. PNG, JPEG, GIF and WebP only, at most 5 per message and 5 MB each before encoding. The server rejects anything else with a 400, before it reaches the stream. Images can be pasted, dropped or picked from a file dialog.
- **Other files** aren't attachments in this amendment. Pi takes only text and images in a prompt, and writing an upload into the Workspace needs a separate path down to the provider. A file can go through the Project library ([ADR 0018](0018-project-library.md)) or be mentioned if it's already in the Workspace.
- **Slash commands.** Pi's `prompt()` already expands `/name` for extension commands, prompt templates and `/skill:name` skills, so sending the text is enough. What the browser lacks is the list. The Session host publishes a `commands` live event with `{ name, description, source }` for each one, the same list Pi's RPC `get_commands` returns, when an attempt starts and after a reload. The server keeps it as an open surface for the current generation, so a browser that connects later gets it in its replay. Typing `/` at the start of the composer opens a filtered menu of these commands.
- **File mentions.** Typing `@` opens a filtered menu of Workspace paths and inserts the chosen path as text, as Pi's editor does. The model reads the file with its own tools. The Session host publishes a `files` live event with the Workspace's paths: `git ls-files` with untracked files that aren't ignored, or a walk that skips hidden folders and `node_modules` outside git. It lists at most 5,000 paths and says when it cut the list short. It is published when an attempt starts and again after each turn ends if the list changed, and is kept as an open surface like `commands`. The browser filters it locally, so typing doesn't wait on a round trip to a laptop.
- Pi's terminal-only commands such as `/model`, `/compact` and `/tree` aren't in the list. They stay in the terminal view until the UI has its own controls for them.

## Consequences

- No message broker, and SQLite on the server as the only store. Because requests carry no connection state apart from SSE and terminal sockets, the server can later run as several replicas without sticky routing for the work channel.
- More moving parts than a single socket: a poll loop, one stream per Session, and a socket per terminal.
- A laptop that sleeps or loses Wi-Fi doesn't kill its Sessions. Its Sessions show as offline and catch up on wake.
- Duplicate execution is prevented by the agent's own process supervision plus the generation check, not by lease expiry. Kubernetes and provider pools in v2 can reschedule a Session elsewhere, so they need expiring leases with self-fencing, which returns as a decision then.
- Server storage grows with every transcript. Retention is not decided.
- Images make transcripts larger, since they are stored inside the JSONL entries. The 5 × 5 MB cap bounds one message, not a Session.
- A large repository's mention list is cut at 5,000 paths. A query down the stream would avoid that, but needs request and response matching over SSE, which nothing else uses yet.
- Relies on Pi appending to its JSONL file rather than rewriting it. The first slice must confirm this, including across compaction and branching.
