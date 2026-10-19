# Existing Pi ecosystem

> Status: integration context. These are existing capabilities Pi Cloud may reuse or adapt. Reuse is not yet a decision to depend on a particular implementation.

## Pi core

Pi supplies the Session runtime:

- full independent `AgentSession` instances;
- native persistent JSONL transcripts;
- SDK and long-lived RPC integration;
- explicit working directories;
- new, open, continue, branch, clone, and fork operations;
- streaming lifecycle and tool events;
- steering and queued follow-ups;
- extension loading and permission dialogs;
- model, effort, tool, skill, and resource selection;
- compaction and clean settlement boundaries.

Pi Cloud should host and orchestrate this runtime rather than implement a second agent loop.

## pi-subagents

`pi-subagents` provides nested delegation inside one Pi Session. A Session may launch bounded children, workflows, review fanout, and isolated worktrees.

Its project-pane feature already proves the hierarchy Pi Cloud needs: a parent Pi Session can open a peer Pi Session rooted in another repository, and that peer owns its own subagents. The parent coordinates it but does not own the peer's nested children.

Project panes are a useful proof and possible prototype primitive. They are not a complete Project model: pane bindings do not provide a durable Project identity, Thread registry, shared instructions and memory, structured reports, routing, provider scheduling, or recovery across machines.

Pi Cloud must keep this distinction:

```text
Project Thread
  full peer Pi Session
    nested pi-subagents work
```

A Thread is never represented as an ordinary subagent run.

## pi-repos

`pi-repos` owns repository inventory and topology:

- canonical repository identities and paths;
- local and cloned repositories;
- groups of related repositories;
- directional connections;
- references;
- summaries and annotations;
- cross-repository search;
- group architecture documents.

A pi-repos Group describes a software system. A Pi Cloud Project describes an ongoing stream of work on that system. They may be linked, but they are not the same resource.

Pi Cloud may use pi-repos as an adapter for repository discovery, group context, and topology. Workspace provisioning and Session worktree ownership remain Pi Cloud runtime concerns.

## pi-task

`pi-task` provides durable implementation plans and task DAGs across Sessions:

- phases and dependencies;
- readiness and blockers;
- acceptance criteria;
- executor hints;
- progress that survives context resets.

A Project may link to a pi-task plan, and a Thread may reference one or more tasks. Pi Cloud should not make every plan task a Session or duplicate the task graph in Project infrastructure.

Projects coordinate conversations and execution; task plans describe work and verification.

## pi-memory

`pi-memory` stores curated durable facts and preferences. It deliberately excludes Session progress, repository-derived facts, and credentials.

Pi Cloud Project memory has a different scope: Project requirements, decisions, coordination preferences, and pitfalls shared across Thread Sessions. The two stores should not be silently merged. Any promotion between them should be explicit and attributable.

## pi-focus

`pi-focus` records a Session's semantic goal, current activity, next step, waiting or blocked state, and handoff. It also tracks top-level long-running tools without storing their output.

This can inform Session status and structured Thread reports, but Pi Cloud should not infer Project completion or verification from a focus state alone.

## pi-github

`pi-github` provides typed GitHub operations, CI/check handling, and session-scoped authority. Pi Cloud may reuse its policy and operation seams for GitHub integration.

A cloud control plane introduces additional credential concerns. Provider-local or brokered Git credentials should remain scoped and should not be replaced by broad tokens mounted into every Session merely because a GitHub extension exists.

## pi-web candidates

The reviewed PI WEB implementations show that Pi can be hosted through a browser with persistent Sessions, workspaces, worktrees, extension questions, and remote runtimes.

`jmfederico/pi-web` is the strongest current reference for:

- a long-lived Session daemon separate from the browser/API process;
- multiple full Pi Sessions;
- projects and workspaces;
- Git worktrees;
- remote-machine federation;
- browser and server plugins;
- hosted-session dispatch and messaging.

Its trust model is personal and explicitly not a multi-tenant sandbox. Pi Cloud owns its control plane and UI and treats PI WEB as a reference ([ADR 0001](adr/0001-own-the-control-plane-and-ui.md)).

## Likely integration boundaries

| Capability                | Existing owner | Possible Pi Cloud role                          |
| ------------------------- | -------------- | ----------------------------------------------- |
| Agent loop and transcript | Pi             | Host through SDK or RPC                         |
| Nested delegation         | pi-subagents   | Available inside every hosted Session           |
| Repository topology       | pi-repos       | Adapter for discovery and shared system context |
| Work planning             | pi-task        | Optional Project and Thread linkage             |
| Curated personal facts    | pi-memory      | Separate from Project coordination memory       |
| Semantic Session activity | pi-focus       | Status signal and report input                  |
| GitHub operations         | pi-github      | Policy-aware integration seam                   |
| Browser Session host      | PI WEB         | Candidate foundation or prototype host          |

These boundaries favor deletion and reuse. Pi Cloud should add distributed control, Projects, Environments, Profiles, Workspaces, Provider Agents, and extension interfaces only where the existing modules do not already own the behavior.
