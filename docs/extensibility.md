# Pi Cloud extensibility

> Status: working model. Pi personalization and platform extensibility are foundational requirements, but the extension contracts are not yet designed.

## Two extension systems

Pi Cloud should preserve Pi's existing customization system and add a separate extension system for control-plane and provider capabilities.

### Pi personalization

Pi already supports:

- packages;
- extensions;
- skills;
- prompt templates;
- themes;
- MCP servers;
- model and provider configuration;
- user and project settings;
- context and system-prompt files.

Hosted Sessions should use these resources through a versioned Profile. Pi Cloud should not invent cloud-only replacements for them.

### Pi Cloud capabilities

Pi Cloud itself needs installable capabilities around Sessions: Runtime Providers, Workspace implementations, source-control integration, Environment builders, triggers, notifications, artifacts, policies, and browser contributions.

The two systems may be shipped together in one package, but they operate at different seams.

## Profile model

A Profile describes which Pi the user expects to run. It may include:

- required and optional Pi packages;
- extensions and skills;
- prompts and instructions;
- MCP configuration;
- models and scoped-model policy;
- preferences and defaults;
- references to credentials without embedding credential values.

A Session records the exact Profile revision it used. Updating a Profile creates a new revision rather than silently changing the historical explanation of an existing Session.

The working configuration precedence is:

1. mandatory Pi Cloud Session bridge;
2. installation policy;
3. selected Profile revision;
4. selected Environment overlay;
5. trusted project configuration;
6. explicit Session overrides.

The merge behavior, migration policy, and treatment of active Sessions remain open.

## Mandatory Session bridge

Every hosted Pi Session likely needs a small first-party companion extension. Its role is protocol integration, not product orchestration.

Expected responsibilities include:

- stable Session and attempt identity;
- lifecycle and liveness reporting;
- event forwarding;
- approval and question routing;
- control messages such as steer, follow-up, stop, and settle;
- Project report submission;
- artifact publication;
- usage and effective-configuration reporting;
- graceful shutdown checkpoints.

It should not implement Project routing, schedules, automation DAGs, or infrastructure scheduling inside the Pi model loop. Those belong to deterministic Control Plane services exposed through narrow tools.

## Platform kernel

The core should remain small enough that optional products can evolve outside it.

Likely kernel resources are:

- actors and ownership;
- Profiles and revisions;
- Environments and revisions;
- Runtime Provider registration and capability discovery;
- Workspaces;
- Sessions, attempts, assignments, and leases;
- Projects and Threads;
- event streams;
- artifacts;
- authorization checks;
- extension discovery and lifecycle.

Features that should not automatically enter the kernel include:

- cron scheduling;
- GitHub or GitLab integrations;
- documentation generation;
- automation DAG engines;
- Slack or email notification providers;
- Jira integration;
- multiplayer presence;
- billing and chargeback;
- specialized review workflows.

First-party versions of those features should use public kernel interfaces.

## Extension categories

A Pi Cloud package may eventually contribute one or more of these capabilities.

| Category                | Examples                                             |
| ----------------------- | ---------------------------------------------------- |
| Runtime Provider        | Local process, remote VM agent, Kubernetes namespace |
| Workspace Provider      | Git worktree, PVC, devcontainer, remote checkout     |
| Source Control Provider | GitHub, GitLab, internal Git hosting                 |
| Environment Builder     | OCI image, setup cache, Nix, devcontainer            |
| Secret Provider         | Kubernetes Secrets, Vault, brokered HTTP credentials |
| Artifact Store          | Local filesystem, S3, MinIO                          |
| Trigger Source          | Cron, webhook, issue tracker, chat event             |
| Automation Engine       | Durable script, DAG, approval workflow               |
| Notification Provider   | Browser push, email, Slack, ntfy                     |
| Policy Provider         | Models, resources, network, approvals, retention     |
| Web Contribution        | Settings forms, Project tabs, status indicators      |
| Pi Companion            | Pi tools and hooks loaded into hosted Sessions       |

The first-party local and Kubernetes providers should use the same provider interface available to third parties. Built-in scheduling or Git integration should not have privileged private paths that extensions cannot use.

## Trust model

Pi extensions run with the Pi process's operating-system authority. Pi Cloud server and provider extensions may be equally powerful.

The personal product may initially allow trusted in-process extensions. The design should still distinguish:

### Trusted in-process extension

Suitable for Runtime drivers, Workspace providers, and storage adapters that require deep integration.

### External capability service

Suitable for webhooks, notifications, automation engines, and third-party integrations. It communicates over an authenticated protocol and cannot block or crash the main process directly.

Extensions should declare capabilities such as:

```text
sessions.read
sessions.start
sessions.control
projects.read
projects.write
artifacts.publish
environments.provide
```

Capability declarations do not need to become a complete sandbox in the first version, but the contract should not assume every extension receives unrestricted authority forever.

## Common execution request

Future features should start work through one provider-neutral request rather than create separate agent runtimes.

A conceptual request contains:

```yaml
actor:
  type: user | coordinator | automation | integration

target:
  type: new-session | existing-session

profile: profile-name-or-revision
environment: environment-name-or-revision
project: optional-project
workspacePolicy: existing | worktree | fresh | ephemeral
prompt: task or follow-up
completion:
  publishArtifacts: true
  notify: []
```

The exact schema is undecided. The important property is that a human message, Project coordinator, schedule, webhook, API request, and future automation flow all enter the same Session execution path.

## Domain events

A durable event stream can let optional features react without coupling them to the model loop. Candidate events include:

```text
SessionCreated
SessionAssigned
SessionStarted
TurnStarted
ApprovalRequested
ThreadReported
ArtifactPublished
SessionSettled
SessionInterrupted
PullRequestOpened
CheckFailed
```

Events are evidence of what happened; current resource state remains authoritative. Event names, retention, delivery guarantees, and replay semantics remain open.

## Automation evolution

Scheduling can begin as a Trigger Source that creates an ordinary execution request. An automation flow can later compose the same primitives:

```text
trigger
  start research Session
  wait for durable report
  start implementation Session
  wait for tests
  start review Session
  publish outcome
```

Workers remain full Pi Sessions and may use their own subagents. A bounded task may select a batch Environment, but this does not create a second agent system.

Example future use cases include:

- scheduled documentation refreshes;
- dependency or security reports;
- pull-request review and CI repair;
- issue triage;
- release preparation;
- periodic repository health checks.

## Collaboration evolution

Multiplayer adds identity, policy, and collaboration state around the same Sessions.

Future concepts may include:

- organizations and groups;
- Project membership;
- viewer, driver, reviewer, and administrator roles;
- presence and handoffs;
- one active-turn or steering lease per Session;
- shared approvals;
- mentions and comments outside model transcripts;
- shared Profiles and Environments;
- audit trails and quotas.

The first single-user schema should retain actor and owner identifiers so it does not hard-code a global singleton owner. It should not implement organization workflows prematurely.

Collaboration state such as presence, read markers, comments, and who answered an approval belongs outside the Pi conversation transcript. The transcript remains the canonical sequence of user, assistant, and tool messages.

## Possible repository module map

The following map records likely module seams, not a decision to create every package or to scaffold them now:

```text
pi-cloud/
  apps/
    server/                 control-plane API and extension host
    web/                    browser and PWA
  packages/
    protocol/               versioned Provider and Session wire types
    core/                   domain and orchestration
    sdk/                    Pi Cloud extension SDK
    runtime-agent/          provider-side agent
    pi-session-bridge/      mandatory Pi companion package
    provider-local/         local and VM process adapter
    provider-kubernetes/    namespace and pod adapter
    projects/               Project capability and UI
  deploy/
    container/
    helm/
    kind/
  docs/
```

Pi Cloud owns this repository boundary ([ADR 0001](adr/0001-own-the-control-plane-and-ui.md)), but the package layout is still open. This map exists so later discussion can place responsibilities without turning one package into a control-plane, runtime, UI, and Kubernetes god module.

## Federation direction

The initial Cell has one owner and one authoritative Control Plane. A later Team Hub could federate personal Cells without immediately merging their provider credentials or filesystem trust boundaries.

A possible future shape is:

```text
Team Hub
  Alice Cell
  Bob Cell
  documentation automation Cell
  review automation Cell
```

The exact federation model is intentionally postponed. The personal Cell should expose versioned APIs and actor attribution without pretending to solve team consistency today.
