# 0011: Server and agent processes

- Status: accepted
- Date: 2026-10-19

## Context

[ADR 0006](0006-provider-protocol.md) fixed the protocol between `pi-cloud server` and `pi-cloud agent`, and [ADR 0010](0010-session-host-on-bun.md) left open whether each Session gets its own host process. v1 has one trusted shared-process mode ([vision](../vision.md#scope)). [ADR 0004](0004-first-slice-and-provider-order.md) expects that killing the agent interrupts its Sessions, and that restarting it starts new attempts.

Claude Code's [Remote Control](https://code.claude.com/docs/en/remote-control) runs the session inside the local `claude` process that registered with the server, so stopping that process ends the session.

The server needs HTTP, server-sent events and, for terminals, WebSockets. Node's `node:http` has no WebSocket server. `Bun.serve` takes a web-standard `fetch` handler and has WebSockets built in. Bun supports both `bun:sqlite` and `node:sqlite`.

## Decision

- The agent runs every Session it hosts in its own process, through the `sessionhost` package. There is no process per Session in v1.
- Each hosted Session still opens its own transcript, live event and command streams to the server, as ADR 0006 requires, so a Session can move into its own process or pod later without changing the protocol.
- The server serves HTTP with `Bun.serve`. Routes are a plain `fetch` handler from `Request` to `Response`, so they don't depend on Bun.
- The server stores Sessions and transcripts with `node:sqlite`.
- Each server and agent process logs one JSON line per event to stderr, with a timestamp.
- A Session whose host fails to start, for example because an extension doesn't load, is marked failed with the error. It is not retried, because the next attempt would fail the same way. ADR 0006's interrupted attempts are retried.
- An interrupted Session keeps the time of its last interruption, so the UI can show it after the Session is running again.

## Consequences

- An agent crash interrupts all of its Sessions at once, which is the behavior ADR 0004 tests for. The agent can't leave an old attempt running while it starts a new one.
- A Pi extension that blocks the event loop or crashes the process affects every Session on that agent. Process isolation returns with the v2 isolation modes.
- Only the server's listener is tied to Bun. Moving it to Node would need a WebSocket library.
