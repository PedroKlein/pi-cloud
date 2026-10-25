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

- Resolved: no auth in v1 behind localhost or an SSH tunnel, and each provider keeps its own Pi model auth ([ADR 0005](adr/0005-v1-access-and-model-credentials.md)). Users log providers in from the web, and the credential stays in the machine's Pi auth ([ADR 0024](adr/0024-provider-login-from-the-web.md)).
- Resolved: a v1 Session only runs on its own provider, so the agent never starts a second attempt while the first is alive, and the server drops messages from old generations ([ADR 0006](adr/0006-provider-protocol.md)).

### Product and repository boundary

- Resolved: Pi Cloud owns its control plane and UI ([ADR 0001](adr/0001-own-the-control-plane-and-ui.md)) and uses TypeScript for every component ([ADR 0002](adr/0002-typescript-for-all-components.md)). The web UI is React and Tailwind on the design system's tokens, with as few dependencies as possible ([ADR 0020](adr/0020-web-stack.md)).
- Resolved: Bun runtime, Bun workspaces monorepo ([ADR 0003](adr/0003-bun-runtime-and-workspaces.md)).
- Resolved: the session host runs Pi, a third-party extension and a PTY terminal on Bun, also from a compiled binary ([ADR 0010](adr/0010-session-host-on-bun.md)).
- Resolved: apps for entry points, domain-named packages, and a separate folder for Pi extensions ([ADR 0008](adr/0008-monorepo-layout.md)).
- Resolved: the server runs natively on the VM as a compiled Bun binary under systemd, with no container image in v1 ([ADR 0009](adr/0009-vm-deployment-and-testing.md)).

### First end-to-end experience

- Resolved: one independent Session end to end on a local provider with a minimal web UI, then VM, then Kubernetes ([ADR 0004](adr/0004-first-slice-and-provider-order.md)).

### Session lifecycle

- Resolved for v1: an idle Session unloads only when it is archived, and unarchiving reloads it from its transcript ([ADR 0013](adr/0013-archive-and-workspace-lifecycle.md)).
- Does the first version keep active Session processes warm indefinitely?
- Which state must be persisted before a Runtime can release a Session?
- Resolved: Sessions keep running while their provider is offline; an attempt is interrupted only when its process dies, and the agent reloads it idle on restart ([ADR 0006](adr/0006-provider-protocol.md)).

### Workspace durability

- Resolved: VM Sessions get a fresh clone each; laptop Sessions use a worktree of an existing checkout, or the folder directly ([ADR 0007](adr/0007-session-workspaces.md)).
- Resolved for v1: a Session's workspace is a folder, a worktree of a folder, or a clone, each of the last two on its own branch, prepared by the provider ([ADR 0012](adr/0012-built-in-provider.md)). How PVCs fit is still open.
- Resolved for v1: a worktree or clone is removed when its Session is archived, and only if git says nothing would be lost; no age sweep or disk budget yet ([ADR 0013](adr/0013-archive-and-workspace-lifecycle.md)).
- What is backed up, replicated and exported? OpenHands applies a disk budget and retention, with a trash folder before deletion ([research](research.md#openhands)).
- Resolved for v2: a Session resumes on another runner when its lease lapses, and can be forked onto another runner as a new Session ([ADR 0032](adr/0032-environments-and-runners.md), [ADR 0034](adr/0034-v2-deployment-and-credentials.md#v2-scope)).

### Profiles and personalization

- Resolved for v2: a Profile is a server record built from Pi packages, instructions, MCP servers and settings; a repository's `.pi` loads on top once trusted, and there are no Environment overlays ([ADR 0031](adr/0031-profiles.md)).
- Resolved for model aliases: alias config and backend health live on the server per Environment, through a `models` plugin with its own gateway ([ADR 0019](adr/0019-model-aliases.md)).
- Resolved: credentials are never in a Profile; each machine keeps provider logins in Pi Cloud's own auth file ([ADR 0031](adr/0031-profiles.md)).
- How are required packages distinguished from optional packages?
- Resolved: Profiles have no revisions; a Session keeps its Profile and loads its current content whenever its process starts ([ADR 0031](adr/0031-profiles.md)).
- Resolved for v2: a package that fails to install or load stops the Session from starting, with an error that names it ([ADR 0031](adr/0031-profiles.md)). Checking ahead of time is open.
- Resolved for v2: Pi's own precedence, with the Profile as personal configuration and a trusted repository's `.pi` as project configuration ([ADR 0031](adr/0031-profiles.md)).

### Control plane and protocol

- Resolved: the first control plane runs on the VM, reached from the laptop through an SSH tunnel ([ADR 0005](adr/0005-v1-access-and-model-credentials.md), [ADR 0009](adr/0009-vm-deployment-and-testing.md)).
- Resolved: the agent long-polls for work and each Session streams on its own over HTTPS and SSE, as Claude Code does; the provider's JSONL stays authoritative and every new entry is copied to the server, which serves browser replay ([ADR 0006](adr/0006-provider-protocol.md)).
- Resolved: the agent hosts its Sessions in its own process, and the server uses `Bun.serve` and `node:sqlite` ([ADR 0011](adr/0011-server-and-agent-processes.md)).
- Which operations are synchronous commands versus desired state reconciled asynchronously?

### Projects and shared state

- Resolved for v1: a Project has one coordinator and thread Sessions, each with its own Workspace holding every Project repository; Project tools are built into the session host ([ADR 0015](adr/0016-projects.md)).
- Which messages should create a new Thread versus reuse an existing one? The coordinator decides; there is no rule yet.
- Resolved for v1: the coordinator gets a short notice when a thread finishes a turn or changes state, and threads message the coordinator explicitly ([ADR 0016](adr/0016-projects.md)). A turn notice starts a coordinator turn; a state change notice doesn't.
- Resolved for v1: any Project Session may write Project memory; the last write wins, and every write is logged ([ADR 0015](adr/0016-projects.md)).
- Resolved for v1: the Project library is a writable shared space on the server, where the last write wins, like memory ([vision](vision.md#v1-personal-sessions-and-projects-on-your-own-machines)). Versioned publications may come later.
- Resolved: a Project's coordinator and threads are Sessions owned by the plugin, hidden from the Session list and shown only inside the Project, whose page is the coordinator's chat with a rail of threads; archiving a Project archives every Session it owns ([ADR 0028](adr/0028-projects-around-the-coordinator.md)).
- How are overlapping repository or file claims detected before work begins?

### Future compatibility without premature implementation

- Resolved: every Session, Environment and plugin record has an `ownerId`, and every command records its `actor` (`user:<id>`, `session:<id>` or `plugin:<name>`) ([ADR 0015](adr/0015-plugins.md#actors-and-owners)).
- What common RunRequest can later serve humans, schedules, webhooks, Projects, and automation flows? OpenHands keeps triggers in a separate service that creates conversations through the public API ([research](research.md#openhands)).
- Which domain events should exist from the beginning?
- How should personal Cells later federate into a Team Hub without merging their local trust boundaries?

## Deferred to v2

These depend on the Kubernetes provider or the public extension SDK, which [vision.md](vision.md#scope) places in v2. v1 uses one trusted shared-process mode and one provider per Environment. Ideas collected for these from prior art are in [v2-ideas.md](v2-ideas.md).

### Runtime and isolation

- When Sessions can move between machines, do they follow Claude Code cloud sessions (resume on fresh compute from the server transcript and a fresh clone), and how does a provider that loses its lease stop its own Sessions? pi-durable resumes mid-turn from its own storage, and OpenHands fences writes with a generation lease ([research](research.md#pi-durable)).
- What is the default Environment isolation mode for a personal Cell?
- Resolved for v2: a runner's capacity decides how many Sessions share it, and capacity one on Kubernetes is a pod per Session [ADR 0032](adr/0032-environments-and-runners.md). Can a shared Runtime safely host several full Pi Sessions? In v1 each Session is its own process on a shared machine ([ADR 0017](adr/0017-process-per-session.md)). OpenHands runs a container per conversation behind a proxy in the host server ([research](research.md#openhands)).
- Where do subagents run when the parent Session has a dedicated pod?
- What resource and concurrency limits prevent nested work from starving other Sessions?

### Environments

- Resolved for v2: an Environment is configuration plus a pool of runners, and a Session whose runner is lost resumes on another one from the server's transcript [ADR 0032](adr/0032-environments-and-runners.md).
- Resolved for v2: Environments have no revisions; an image and a setup script make the baseline, cached where the runner can [ADR 0032](adr/0032-environments-and-runners.md).
- Resolved for v2: an optional image plus a setup script, with the setup cache on a volume where available [ADR 0032](adr/0032-environments-and-runners.md).
- Which network-policy claims can be strongly enforced on each provider? Network rules are deferred past v2 ([ADR 0034](adr/0034-v2-deployment-and-credentials.md#v2-scope)).
- Resolved for the first v2 slice: Environment secrets are stored on the server and readable by the Session; brokered secrets come after v2. Stored values are encrypted with a master key, and a git token among them gives runners git access ([ADR 0034](adr/0034-v2-deployment-and-credentials.md)).
- May Project coordinators and worker Threads use different default Environments?

### Extension system

- What is the smallest stable Pi Cloud extension interface? v1 has an internal one with server, session and web parts ([ADR 0015](adr/0015-plugins.md)); what to freeze for the public SDK is open.
- Resolved: a Session may propose a plugin but only the user enables it, and third-party plugins install turned off ([ADR 0022](adr/0022-plugin-model-v2.md#installing-third-party-plugins)).
- Resolved for v2: plugins are installed and turned on for the whole installation, and changing them restarts the server; each user's Pi personalization stays in their Profile ([ADR 0022](adr/0022-plugin-model-v2.md#plugins-are-per-installation)).
- Resolved for v2: third-party web parts run in the page like first-party ones, with no sandboxed iframe ([ADR 0022](adr/0022-plugin-model-v2.md#trust)).
- Resolved for v2: Pi Cloud is changed from chat in meta-sessions, which run on a built-in read-only Profile, get toolsets that plugins contribute, ask before risky calls and can drive the UI; the same toolsets are served over MCP, and a meta-session can write in-place plugins ([ADR 0035](adr/0035-meta-sessions.md)). How a meta-session's powers vary per user is left for v3.
- Is an integrated browser still wanted, and if so as a preview iframe the agent drives through an injected script, or in a desktop app? The CDP screencast was rejected ([ADR 0022](adr/0022-plugin-model-v2.md#no-browser-plugin-yet)).
- Which extension types run inside the control plane, Provider Agent, browser, or Pi Session?
- Resolved: plugins declare settings with defaults in their manifest, values are stored per installation and edited on a Plugins page, and a plugin that fails to start is turned off and reported instead of stopping the server ([ADR 0036](adr/0036-plugin-settings.md)).
- Resolved for v2: a plugin declares `capabilities` and `requires` in its manifest; the exact capability names are open ([ADR 0022](adr/0022-plugin-model-v2.md#a-small-manifest)).
- Which first-party features must prove the public extension surface?
- How are blocking or faulty trusted extensions diagnosed and disabled safely?
- Resolved: Chromium resolves `*.localhost` for previews, which cover pages a Session opens through `BROWSER` ([ADR 0037](adr/0037-previews-and-opened-pages.md)). Other browsers are checked as they are used.
- Resolved: server tools repair JSON-encoded arguments before Pi validates them, built-in plugins may import only the SDK packages, lists update from change events instead of polling, and the usage plugin shows how full the context is ([ADR 0038](adr/0038-tool-repair-change-events-and-context.md)).
- Can an in-place plugin's web part be loaded in a sandboxed headless page before the user turns it on, to report runtime errors, without running its code anywhere it can reach something ([ADR 0038](adr/0038-tool-repair-change-events-and-context.md#later-checking-an-in-place-plugin-before-it-is-turned-on))?
- Can a compiled Bun binary import plugin files from outside itself? It is checked when ADR 0022's third-party install is built.

## Explicitly postponed

- Organization membership and invitation flows.
- Multiplayer presence and simultaneous steering.
- Billing and chargeback.
- General-purpose durable workflow syntax.
- Marketplace and third-party extension distribution policy.
- Transparent live-process migration between providers.
