# 0001: Own the control plane and UI

- Status: accepted
- Date: 2026-10-16

## Context

Existing Pi web hosts, chiefly [PI WEB](https://github.com/jmfederico/pi-web) and [Paseo](https://paseo.sh/pi), already run persistent Pi Sessions behind a browser or app, use Git worktrees, and reach remote machines. None of them model Projects with full Thread Sessions, versioned Profiles and Environments, leased and fenced attempts, or Kubernetes providers.

Pi Cloud could start as plugins on one of those hosts, fork one, or own its own control plane and UI.

## Decision

Pi Cloud builds its own Control Plane, Provider Agent, Session host, Session bridge, and web UI. Existing Pi web hosts are references, not dependencies.

Pi itself (the SDK, the native transcript, and the package and extension system) and existing Pi packages such as pi-subagents remain reused inside hosted Sessions.

## Consequences

- Pi Cloud's resource model (Projects, Threads, Environments, attempts) is not constrained by another host's plugin contract or trust model.
- Pi Cloud carries the cost of building the browser experience, Session streaming, and reconnect handling that PI WEB already has.
- The UI's design is a separate, later decision.
