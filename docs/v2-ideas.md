# Ideas for v2

> Status: backlog of ideas, not decisions. Each one comes from prior art we read ([research](research.md)). An idea becomes work only through an ADR or an issue, and an open question it touches stays in [open-questions.md](open-questions.md).

v2 adds Kubernetes, stronger isolation and a public extension interface ([vision](vision.md#scope)). These are the ideas worth taking with us when we get there.

## Running a Session on fresh compute

- **Resume mid-turn.** pi-durable commits a tool call's intent before running it and checkpoints every model turn. A process that dies mid-turn picks up where it stopped. A tool marked replay-safe reruns, and any other gets an `interrupted` result with the output so far. This is the likely answer to resuming a Session in a new pod, and the session host is where it would plug in.
- **Expiring leases with fencing.** ADR 0006 deferred these. OpenHands' conversation lease holds an owner, a generation and a 45 second TTL. A new owner bumps the generation, and every write checks ownership first. When the owner is on the same host and its pid is dead, takeover is immediate. Our server-side version would be the same rows in SQLite.
- **Crash-loop guard.** pi-durable parks a task after 5 restarts without progress, reports it once, and offers an explicit retry. A Session that keeps killing its pod needs the same.

## Isolation

- **A container per Session behind a proxy.** OpenHands can run each conversation in its own container with its own Agent Server. The host server proxies HTTP and WebSocket traffic to it and gives each container its own API key and encryption key. Workspace and state are mounted, so a replaced container keeps its history. Our provider could do the same without changing the protocol, because ADR 0011 already keeps each Session's streams separate.
- **Reprovision.** OpenHands exposes `POST /conversations/{id}/runtime/reprovision` to replace a broken container in place. A "restart this Session's runtime" action is cheap to offer once Sessions have their own runtime.

## Credentials

- **Inject credentials into fresh runtimes.** Today each provider uses its own Pi auth (ADR 0005). A pod has no home directory login. OpenHands handles this by taking the contents of `~/.pi/agent/auth.json` as a secret (`PI_AUTH_JSON`) and writing it into the container.
- **Encrypt stored secrets.** OpenHands encrypts secrets in stored conversations with a server key (`OH_SECRET_KEY`) and treats a missing key as "secrets don't survive a restart".

## Authentication, once v1's no-auth rule ends

- Inject a session key into the page only on a loopback bind. On any other bind, ask for the key.
- Don't keep keys in `localStorage`. OpenHands' own guide warns that any script on the same origin, including its bundled editor, can read every backend's key.
- Use an `HttpOnly; SameSite=Strict` cookie for WebSocket upgrades, since the browser can't set a header on one. OpenHands' DigitalOcean bridge does this.

## Projects and subagents

- **Conversations owned by tasks.** In pi-durable a subagent's conversation is owned by the tool call that made it. Aborting the call aborts the child, the parent is idle only once the child is, and a background task is the boundary for work that should outlive its parent. That maps onto a coordinator and its threads.
- **Task graph view.** pi-durable shows every live task with its owner, status and the conversations it owns. A Project needs the same picture.
- **Child conversations with their own worktree.** OpenHands starts a child conversation that inherits the parent's settings and can get its own git worktree. That's close to ADR 0007's laptop default.
- **Notes the model doesn't see.** pi-durable can append an entry that changes nothing the model sees, even mid-run. Useful for Project bookkeeping in a thread's transcript.

## Schedules and automations

- **Durable sleeps.** pi-durable stores a sleep with its wake time, so a sleeping task holds no process and survives restarts. A host that can be evicted gets an `onWake` callback with the next time it needs to run.
- **Triggers as a separate client.** OpenHands keeps automations in their own service. It decides when to run and creates conversations through the public API. The server has no special path for them.
- **Webhooks on events.** OpenHands' Agent Server can POST batched events to configured URLs with retries. It's a simple first integration point.

## Extensions

- **Hooks around tool calls.** Both projects have them: pi-durable's `beforeTool` can block a call, and OpenHands has `PreToolUse` and `PostToolUse`. A Pi Cloud policy extension (approvals, audit) would sit there.
- **Install and enable are separate.** OpenHands installs UI extensions disabled. An agent may install one, but only the user enables it. The backend owns installed extensions, pinned to a resolved revision.
- **Tell the agent where it is.** OpenHands appends the URLs of the services around the agent to its context, so it doesn't guess ports. Our cloud-bridge extension could do the same for preview URLs.

## Observability

- **Content-free telemetry.** pi-durable's telemetry schema carries IDs and control metadata only, never messages, arguments or results. OpenHands' telemetry is off by default, has an operator kill switch, and drops queued events when consent is revoked.

## Streaming

- **Give a slow watcher the current state.** pi-durable keeps at most 100 undelivered frames for a watcher, then replaces them with one frame holding the whole current view. That's an alternative to closing the connection, worth reconsidering if the transcript stops being append-only.

## Other agents

- **ACP as a seam.** OpenHands runs other agents (Claude Code, Codex, Gemini, Pi) as ACP subprocesses. Pi Cloud embeds Pi directly, which is the point. ACP could still be the way to host a non-Pi agent later.

## Testing

- **Shared conformance suites.** pi-durable ships one test suite that every storage and execution environment must pass. Worth doing once a second store or a second provider type exists, so both are held to the same contract.
