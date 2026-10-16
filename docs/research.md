# Pi Cloud research notes

> Status: research snapshot. These facts informed the vision but do not dictate Pi Cloud's implementation.

## Claude Projects

Official documentation describes a Project as one coordinating conversation plus full thread sessions.

Documented properties:

- Each Thread is a separate Claude Code session with its own context window.
- Each cloud Thread clones the Project repositories into its own cloud sandbox and works on its own branch. Project Threads do not share one checkout through worktrees.
- Threads can use subagents, agent teams, loops, and workflows inside their own Session.
- The coordinator sees Thread reports rather than every internal step.
- Project instructions are supplied to the coordinator and each new Thread.
- Project memory is stored as files. Each cloud Thread reads the `MEMORY.md` index at startup and opens other memory files when needed.
- Uploaded Project files are copies readable under `/mnt/project-files`.
- Files produced by Threads appear in the Project Library.
- The documentation does not specify locking, versioning, or merge semantics for concurrent Project-memory updates.

Sources:

- [Claude Projects](https://code.claude.com/docs/en/claude-projects)
- [Projects redesigned](https://claude.com/resources/articles/projects-redesigned)

## Claude cloud Environments

An Environment is reusable configuration selected when a cloud Session starts. It is not a Project and is not a shared writable Workspace.

Documented Environment responsibilities include:

- network access level and domain policy;
- environment variables;
- network secrets held outside an Anthropic-hosted Session VM;
- a setup script;
- cached filesystem contents such as installed packages, files, and Docker images;
- organization or personal availability.

The setup cache keeps filesystem changes, packages, and pulled images, but not running processes. Project Threads use the Environment selected in Project settings.

Anthropic-hosted Sessions pause after a short idle period with files saved. A paused VM may later be reclaimed; reopening then provisions fresh compute and restores conversation history, but not running subagents, shell commands, or background loops. Public documentation does not promise that arbitrary uncommitted filesystem state survives full reclamation.

Sources:

- [Cloud Environments](https://code.claude.com/docs/en/cloud-environments)
- [Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web)

## Claude self-hosted Environments

Claude's self-hosted design separates the hosted control plane from customer-operated runners:

- Sessions target an Environment runner pool, not one named runner.
- Runners register outbound, poll for work, claim a Session lease, and stream events.
- One runner may have capacity for several Sessions owned by the same user.
- Anthropic recommends fresh capacity-one containers or VMs for stronger production isolation, although one runner can technically host several Sessions for the same owner.
- Each Session is a child process with per-session directories or worktrees.
- A Session may resume on another runner, so runners in one Environment must be configured consistently.

Sources:

- [Self-hosted Environments](https://code.claude.com/docs/en/self-hosted-environments)
- [Deploy self-hosted Environments](https://code.claude.com/docs/en/self-hosted-environments-deploy)
- [Self-hosted Environment configuration](https://code.claude.com/docs/en/self-hosted-environments-configuration)

## Pi capabilities

Pi already provides the main Session-runtime primitives Pi Cloud needs:

- persistent native JSONL Sessions;
- full independent `AgentSession` instances;
- SDK and long-lived RPC integration;
- explicit working directories;
- session open, continue, fork, and branch operations;
- lifecycle and streaming events;
- steering and queued follow-ups;
- extension loading and permission dialogs;
- model, effort, tool, and skill selection;
- compaction and settlement boundaries;
- nested subagents and workflows.

Pi Cloud still needs to supply the distributed layer: Environment and Profile registries, Provider Agents, scheduling and leases, Workspace provisioning, event replay, Projects and Thread reports, shared memory, artifact publication, and the browser control plane.

Sources:

- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi CLI integration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli-integration.md)
- [Pi Sessions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md)
- [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

## Open-source prior art

### PI WEB

[jmfederico/pi-web](https://github.com/jmfederico/pi-web) is the strongest Pi-native reference. It provides a long-lived Session daemon, full Pi Sessions, workspaces and Git worktrees, remote-machine federation, browser/server plugins, and hosted-session dispatch. Its trust model is personal and explicitly not a multi-tenant sandbox.

### Paddock

[edspencer/paddock](https://github.com/edspencer/paddock) provides useful patterns for Project context, persistent chats, provenance, reconnectable event streams, spawned chats, triggers, and curated Project knowledge. It is Claude-specific.

### Clay Studio

[chadbyte/clay](https://github.com/chadbyte/clay) is useful prior art for multi-user live Sessions, permissions, presence, handoffs, portable on-disk state, push notifications, and optional Linux-user isolation. It is not Pi-native and uses the AGPL-3.0-only license.

### Agentrove

[Mng-dev-ai/agentrove](https://github.com/Mng-dev-ai/agentrove) demonstrates lead chats that spawn worker subthreads, worktree isolation, channels, and Docker or host sandboxes. Its workers remain flat rather than recursively full Project Threads.

### Agent Console

[ms2sato/agent-console](https://github.com/ms2sato/agent-console) demonstrates worktree delegation, parent reporting, cross-session messages, timers, and GitHub webhook routing. Its stated security model is local and personal.

### Ambient Code Platform

[ambient-code/platform](https://github.com/ambient-code/platform) is useful Kubernetes prior art for CRDs, operators, Jobs, namespace-scoped access, and multi-repository outcomes. Its execution model is Job-oriented rather than a full durable Pi Session model.

### OpenHands

[All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) provides useful sandbox and Kubernetes-runtime lessons. Its open-source product is primarily personal-workstation oriented; team cloud and stronger tenant capabilities follow a different product boundary.

### Coder and Daytona

[coder/coder](https://github.com/coder/coder) and [daytonaio/daytona](https://github.com/daytonaio/daytona) are possible Workspace or sandbox substrates. They do not provide the Pi Session, Project coordinator, Thread report, or Pi personalization model by themselves.

### Kubernetes Claude platforms

Several open-source systems create one Job or pod for a bounded Claude task. They are useful for operator, RBAC, and workspace patterns, but their batch lifecycle does not directly solve durable interactive Pi Sessions.

## Research conclusion

No reviewed project combines Pi-native Session fidelity, Claude-style Projects and Threads, portable Environments, strong Kubernetes execution, and future collaboration. PI WEB may be a useful foundation or prototype host, but whether Pi Cloud can remain an external plugin layer is still an open decision.
