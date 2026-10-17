# 0004: First slice and provider order

- Status: accepted
- Date: 2026-10-17

## Context

Pi Cloud's riskiest claims sit below Projects: the split between the Control Plane and Provider Agents, leased and fenced attempts, reconnect and replay, and running the Session host on Bun ([ADR 0003](0003-bun-runtime-and-workspaces.md)). Projects are built from Sessions, so they depend on all of these.

A Pi TUI front end was considered for the first client. Pi's interactive TUI drives an `AgentSession` in its own process. Running it locally with Pi Cloud extensions would skip the Provider protocol. Using it as a client of a remote Session would mean rebuilding interactive mode on `pi-tui` against Pi Cloud's event stream, which costs about as much as a basic web client and is not the browser and phone experience the product targets.

## Decision

The first slice is one independent Session, with no Projects, working end to end:

1. The web UI creates a Session in a local Environment.
2. The Control Plane (Bun and SQLite) persists and queues it. A local Provider Agent on the same machine claims it over the real outbound protocol.
3. The Session host starts Pi with a Profile, one third-party Pi extension, and an interactive terminal.
4. The user chats from the browser. Closing and reopening the tab replays the stream.
5. Killing the Provider Agent marks the attempt interrupted. Restarting it continues the Session as a new fenced attempt.

The first client is a deliberately minimal web UI: Session list, streaming chat, approval prompts, and a terminal. Visual and interaction design is a later decision.

Providers are built in this order: local, then VM, then Kubernetes.

## Consequences

- The slice exercises the protocol, leases, replay, and the Bun Session host before Projects build on them.
- The VM provider should be mostly the local Provider Agent on another host once the protocol is real.
- Kubernetes adds images, PVCs, and pods last.
- The Control Plane exposes one client protocol, so a TUI client on `pi-tui`, or a Pi extension that hands a local Session to Pi Cloud, can be added later as another client.
