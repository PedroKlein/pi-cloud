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

### Product and repository boundary

- Resolved: Pi Cloud owns its control plane and UI ([ADR 0001](adr/0001-own-the-control-plane-and-ui.md)) and uses TypeScript for every component ([ADR 0002](adr/0002-typescript-for-all-components.md)).
- Resolved: Bun runtime, Bun workspaces monorepo ([ADR 0003](adr/0003-bun-runtime-and-workspaces.md)).
- Which packages does the monorepo start with?
- Is the first supported deployment native, containerized, Kubernetes-only, or several modes from the beginning?

### First end-to-end experience

- Should the first proof cover independent remote Sessions, Projects and peer Threads, or Environment dispatch?
- What is the smallest flow that proves the architecture rather than only the UI?
- Which provider should come first: local process, VM agent, or Kubernetes namespace?

### Runtime and isolation

- What is the default Environment isolation mode for a personal Cell?
- Can a shared Runtime safely host several full Pi Sessions, or should every active Session get a pod?
- Where do subagents run when the parent Session has a dedicated pod?
- What resource and concurrency limits prevent nested work from starving other Sessions?

### Session lifecycle

- When may an idle Session unload or stop?
- Does the first version keep active Session processes warm indefinitely?
- Which state must be persisted before a Runtime can release a Session?
- How are interrupted attempts shown and recovered?
- What lease and fencing protocol prevents duplicate execution after partitions?

### Workspace durability

- How are repository mirrors, clones, and worktrees organized?
- Is storage shared per user, separate per Session, or selected by Environment policy?
- How are local paths, VM directories, and PVCs represented by one Workspace interface?
- What is backed up, replicated, exported, and garbage-collected?
- Can a Session migrate between providers, or should cross-provider continuation begin as a fork?

### Profiles and personalization

- Which Pi configuration belongs in a Profile versus an Environment or project checkout?
- How are credentials excluded from portable Profile data?
- How are required packages distinguished from optional packages?
- When a Profile revision changes, do existing Sessions stay pinned, reload, or migrate?
- How are extension compatibility and native dependencies validated against an Environment?
- What is the exact configuration precedence and merge behavior?

### Environments

- Is an Environment tied to one Runtime Provider, or can equivalent providers serve one Environment pool?
- How are Environment revisions built and cached?
- Do initial Kubernetes Environments use immutable OCI images, setup volumes, or both?
- Which network-policy claims can be strongly enforced on each provider?
- How are readable secrets distinguished from future brokered network credentials?
- May Project coordinators and worker Threads use different default Environments?

### Control plane and protocol

- Where does the first control plane run?
- What protocol connects Provider Agents and hosted Sessions to it?
- How are live events buffered and replayed after reconnects?
- Which component owns the authoritative Pi transcript while a Session runs?
- How frequently is transcript state replicated away from a provider?
- Which operations are synchronous commands versus desired state reconciled asynchronously?

### Projects and shared state

- Which messages should create a new Thread versus reuse an existing one?
- What structured report contract keeps coordinator context small?
- Who may write Project memory, and how are concurrent updates versioned or reviewed?
- Are Library artifacts immutable publications, versioned files, or a writable shared space?
- How are overlapping repository or file claims detected before work begins?

### Extension system

- What is the smallest stable Pi Cloud extension interface?
- Which extension types run inside the control plane, Provider Agent, browser, or Pi Session?
- What capabilities must an extension declare?
- Which first-party features must prove the public extension surface?
- How are blocking or faulty trusted extensions diagnosed and disabled safely?

### Future compatibility without premature implementation

- Which ownership and actor fields should exist now to avoid a single-user data-model dead end?
- What common RunRequest can later serve humans, schedules, webhooks, Projects, and automation flows?
- Which domain events should exist from the beginning?
- How should personal Cells later federate into a Team Hub without merging their local trust boundaries?

## Explicitly postponed

- Organization membership and invitation flows.
- Multiplayer presence and simultaneous steering.
- Billing and chargeback.
- General-purpose durable workflow syntax.
- Marketplace and third-party extension distribution policy.
- Transparent live-process migration between providers.
