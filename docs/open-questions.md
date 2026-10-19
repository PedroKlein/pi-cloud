# Pi Cloud open questions

> Status: decision backlog. Items here are intentionally unresolved. Move an item into an ADR only after its context, alternatives, decision, and consequences are understood.

## Direction already agreed

- The first product is a self-hosted personal control plane.
- It manages multiple independent Sessions and multiple Projects.
- Project coordinators and Threads are full Pi Sessions.
- Every Thread can use its own subagents.
- One logical control plane can use local, VM, and Kubernetes Runtime Providers.
- Sessions bind to versioned Profiles and Environments.
- Pi personalization must remain available in hosted sessions.
- The platform should be extensible enough for later automations and collaboration.

## Decisions needed before an implementation plan

### Blocking the first slice

- Resolved: no auth in v1 behind localhost or an SSH tunnel, and each provider keeps its own Pi model auth ([ADR 0005](adr/0005-v1-access-and-model-credentials.md)).
- Resolved: a v1 Session only runs on its own provider, so the agent never starts a second attempt while the first is alive, and the server drops messages from old generations ([ADR 0006](adr/0006-provider-protocol.md)).

### Product and repository boundary

- Resolved: Pi Cloud owns its control plane and UI ([ADR 0001](adr/0001-own-the-control-plane-and-ui.md)) and uses TypeScript for every component ([ADR 0002](adr/0002-typescript-for-all-components.md)).
- Resolved: Bun runtime, Bun workspaces monorepo ([ADR 0003](adr/0003-bun-runtime-and-workspaces.md)).
- Resolved: the session host runs Pi, a third-party extension and a PTY terminal on Bun, also from a compiled binary ([ADR 0010](adr/0010-session-host-on-bun.md)).
- Resolved: apps for entry points, domain-named packages, and a separate folder for Pi extensions ([ADR 0008](adr/0008-monorepo-layout.md)).
- Resolved: the server runs natively on the VM as a compiled Bun binary under systemd, with no container image in v1 ([ADR 0009](adr/0009-vm-deployment-and-testing.md)).

### First end-to-end experience

- Resolved: one independent Session end to end on a local provider with a minimal web UI, then VM, then Kubernetes ([ADR 0004](adr/0004-first-slice-and-provider-order.md)).

### Session lifecycle

- When may an idle Session unload or stop?
- Does the first version keep active Session processes warm indefinitely?
- Which state must be persisted before a Runtime can release a Session?
- Resolved: Sessions keep running while their provider is offline; an attempt is interrupted only when its process dies, and the agent reloads it idle on restart ([ADR 0006](adr/0006-provider-protocol.md)).

### Workspace durability

- Resolved: VM Sessions get a fresh clone each; laptop Sessions use a worktree of an existing checkout, or the folder directly ([ADR 0007](adr/0007-session-workspaces.md)).
- How are local paths, VM directories, and PVCs represented by one Workspace interface?
- What is backed up, replicated, exported, and garbage-collected? OpenHands applies a disk budget and retention, with a trash folder before deletion ([research](research.md#openhands)).
- Can a Session migrate between providers, or should cross-provider continuation begin as a fork?

### Profiles and personalization

- Which Pi configuration belongs in a Profile versus an Environment or project checkout?
- How are credentials excluded from portable Profile data?
- How are required packages distinguished from optional packages?
- When a Profile revision changes, do existing Sessions stay pinned, reload, or migrate?
- How are extension compatibility and native dependencies validated against an Environment?
- What is the exact configuration precedence and merge behavior?

### Control plane and protocol

- Resolved: the first control plane runs on the VM, reached from the laptop through an SSH tunnel ([ADR 0005](adr/0005-v1-access-and-model-credentials.md), [ADR 0009](adr/0009-vm-deployment-and-testing.md)).
- Resolved: the agent long-polls for work and each Session streams on its own over HTTPS and SSE, as Claude Code does; the provider's JSONL stays authoritative and every new entry is copied to the server, which serves browser replay ([ADR 0006](adr/0006-provider-protocol.md)).
- Resolved: the agent hosts its Sessions in its own process, and the server uses `Bun.serve` and `node:sqlite` ([ADR 0011](adr/0011-server-and-agent-processes.md)).
- Which operations are synchronous commands versus desired state reconciled asynchronously?

### Projects and shared state

- Which messages should create a new Thread versus reuse an existing one?
- What structured report contract keeps coordinator context small?
- Who may write Project memory, and how are concurrent updates versioned or reviewed?
- Are Library artifacts immutable publications, versioned files, or a writable shared space?
- How are overlapping repository or file claims detected before work begins?

### Future compatibility without premature implementation

- Which ownership and actor fields should exist now to avoid a single-user data-model dead end?
- What common RunRequest can later serve humans, schedules, webhooks, Projects, and automation flows? OpenHands keeps triggers in a separate service that creates conversations through the public API ([research](research.md#openhands)).
- Which domain events should exist from the beginning?
- How should personal Cells later federate into a Team Hub without merging their local trust boundaries?

## Deferred to v2

These depend on the Kubernetes provider or the public extension SDK, which [vision.md](vision.md#scope) places in v2. v1 uses one trusted shared-process mode and one provider per Environment.

### Runtime and isolation

- When Sessions can move between machines, do they follow Claude Code cloud sessions (resume on fresh compute from the server transcript and a fresh clone), and how does a provider that loses its lease stop its own Sessions? pi-durable resumes mid-turn from its own storage, and OpenHands fences writes with a generation lease ([research](research.md#pi-durable)).
- What is the default Environment isolation mode for a personal Cell?
- Can a shared Runtime safely host several full Pi Sessions, or should every active Session get a pod? OpenHands runs a container per conversation behind a proxy in the host server ([research](research.md#openhands)).
- Where do subagents run when the parent Session has a dedicated pod?
- What resource and concurrency limits prevent nested work from starving other Sessions?

### Environments

- Is an Environment tied to one Runtime Provider, or can equivalent providers serve one Environment pool?
- How are Environment revisions built and cached?
- Do initial Kubernetes Environments use immutable OCI images, setup volumes, or both?
- Which network-policy claims can be strongly enforced on each provider?
- How are readable secrets distinguished from future brokered network credentials?
- May Project coordinators and worker Threads use different default Environments?

### Extension system

- What is the smallest stable Pi Cloud extension interface?
- May a Session install extensions, or only propose them? OpenHands installs UI extensions disabled and lets only the user enable them ([research](research.md#openhands)).
- Which extension types run inside the control plane, Provider Agent, browser, or Pi Session?
- What capabilities must an extension declare?
- Which first-party features must prove the public extension surface?
- How are blocking or faulty trusted extensions diagnosed and disabled safely?

## Explicitly postponed

- Organization membership and invitation flows.
- Multiplayer presence and simultaneous steering.
- Billing and chargeback.
- General-purpose durable workflow syntax.
- Marketplace and third-party extension distribution policy.
- Transparent live-process migration between providers.
