# Pi Cloud vision

> Status: directional foundation. This explains what Pi Cloud is trying to become. It is not an implementation specification.

## Goal

Pi Cloud is a foundation for running Pi at scale. It is a small kernel that runs full Pi sessions wherever the work fits best, plus a plugin system as open as Pi's own. Every feature on top is a plugin: Projects first, later Jobs, Workflows, integrations and team features.

The kernel makes full Pi sessions available from a browser, phone, terminal, or editor while the work runs on a laptop, a VM, or later Kubernetes. Plugins decide what that work is for.

One personal installation should be able to manage:

- ordinary independent Pi sessions;
- multiple long-running Projects;
- multiple full thread sessions inside each Project;
- reusable execution Environments backed by a laptop, VM, or Kubernetes namespace;
- the user's complete Pi personalization;
- extension-provided capabilities.

The first product is a control plane for one user. The same foundation is meant to carry what comes after: automations for a team, multiplayer Projects, and software factories built for specific apps. Those are plugins and policies on the same kernel, not a second system.

## Use cases

These scenarios are the yardstick for scope. A feature that serves none of them waits. They are a first draft and should be edited as real use shows what matters.

1. **Work from anywhere.** Start a refactor on the always-on VM from a phone, close the app, and check the result later from a laptop browser with the full transcript and terminal intact.
2. **Use the machine the work needs.** A Session that needs a local simulator, keychain, or database runs on the laptop, while the rest of the Project keeps running on the VM.
3. **Run a Project.** One coordinator Session splits a goal into three Thread Sessions across two repositories, each on its own branch, and summarizes their reports without reading every transcript.
4. **Survive interruptions.** A laptop sleeps or a provider crashes mid-turn. The Session shows the interrupted attempt and continues from its persisted transcript and Workspace once the provider is back.
5. **Keep personalization.** Hosted Sessions use the same Pi packages, extensions, skills, prompts, and models as the user's local Pi.

## Scope

### v1: personal sessions and Projects on your own machines

- Independent Sessions and Projects with full Thread Sessions.
- An internal plugin interface. Projects and the other first-party features are default plugins on it ([ADR 0015](adr/0015-plugins.md)).
- Local and VM Runtime Providers, connected outbound to one Control Plane.
- A Project file library, as a plugin after Projects: uploads, files published by threads, and files fetched into a thread's workspace.
- One trusted mode with no sandbox: each Session runs in its own process on the provider's machine ([ADR 0017](adr/0017-process-per-session.md)). An Environment is a name for one provider ([ADR 0014](adr/0014-concept-map-and-environments.md)).
- A Session stays on the provider it started on, for its whole life.
- No authentication. The Control Plane listens on localhost and is reached there or through an SSH tunnel, including from a phone ([ADR 0005](adr/0005-v1-access-and-model-credentials.md)).
- A minimal web UI.

v1 is done when all five use cases above pass on the laptop and the VM with a cheap real model, as much of each as possible also runs in CI on the faux model, and no v1 issue is open. Each run is written up with its logs or screenshots. The v1 runs are in [acceptance/v1.md](acceptance/v1.md).

### v2: execution platform

- Kubernetes provider, dedicated Session pods, and batch Jobs.
- Authentication for the web UI and Provider Agent enrollment, once the Control Plane is reachable beyond a tunnel: a built-in password login, OIDC as a plugin, and a key per Environment for runners ([ADR 0033](adr/0033-v2-authentication-and-order.md)).
- Profiles defined on the server, which every provider uses, including fresh runtimes ([ADR 0031](adr/0031-profiles.md)).
- Forking a Session onto another runner, starting from the server's copy of its transcript ([ADR 0034](adr/0034-v2-deployment-and-credentials.md#v2-scope)).
- Pi Cloud on SAP's Kyma as a container image and a Helm chart, with HTTPS in Kyma's gateway ([ADR 0034](adr/0034-v2-deployment-and-credentials.md)).
- A public Pi Cloud extension SDK, published once two real providers use the same internal seams.

v2 is built in this order: Profiles, Environments as pools, authentication, Kubernetes, meta-sessions ([ADR 0035](adr/0035-meta-sessions.md)), then automation plugins such as Jobs, AI workflows and software factories, with the plugin pieces in between ([ADR 0033](adr/0033-v2-authentication-and-order.md)).

### v3: a team's control center

v3 turns one person's Pi Cloud into a place where a team works. v2 already prepares for it: every record has an owner, authentication has real users, and a runner serves one owner at a time ([ADR 0032](adr/0032-environments-and-runners.md), [ADR 0033](adr/0033-v2-authentication-and-order.md)).

- Inviting people, roles and permissions.
- Shared organization Environments and Profiles.
- Multiplayer Projects: shared Sessions, presence, handoffs and approvals.
- Usage policy, quotas and audit trails.

The scope of v3 is designed once v2 is under way.

### Later

Enforced network policy, brokered secrets and hardened runtimes ([ADR 0034](adr/0034-v2-deployment-and-credentials.md#v2-scope)), and everything else under "Expected evolution" below.

## Product model

A Project is one ongoing goal and coordinating conversation. Its workers are threads, and each thread is a full Pi session. Threads are not renamed subagents: a thread can use its own subagents, workflows, tools, context window, workspace, and model configuration.

Independent sessions remain first-class. A user does not need to create a Project for work that fits one conversation.

An Environment is a reusable execution definition. A session binds to an Environment, and the server places it on a runner in that Environment's pool ([ADR 0032](adr/0032-environments-and-runners.md)). This allows the same control plane to dispatch work locally, to an always-on VM, or to Kubernetes.

## Principles

### Small kernel, everything else is a plugin

The kernel runs Sessions: Environments, providers, Workspaces, transcripts, terminals, events, server tools and one way to start work. Projects, Jobs, Workflows, integrations and team features are plugins. First-party plugins ship on by default and use only the seams any plugin gets, so a feature can be turned off, replaced, or written by someone else ([ADR 0015](adr/0015-plugins.md)).

### The UI is extensible too

A plugin can bring its own pages, panels and message views, built with whatever it likes. The kernel UI is a shell around Sessions.

### One way to start work

A person, a Project coordinator, a schedule, a webhook and a software factory all start Sessions through the same start request. Nothing gets a separate agent runtime.

### Pi remains Pi

Hosted sessions must use Pi's normal runtime and session model. Pi Cloud should orchestrate Pi, not replace its agent loop with a reduced cloud-specific implementation.

### Personalization is portable

The user's required packages, extensions, skills, prompts, instructions, models, MCP servers, and preferences must be available to hosted sessions. This configuration belongs in a Profile defined on the server, and each Session records which Profile it uses ([ADR 0031](adr/0031-profiles.md)).

A small mandatory session bridge may be loaded to connect a Pi session to the control plane. It should provide hosting protocol functions only. Projects and automations should remain control-plane capabilities exposed through narrow tools.

### Sessions are the execution primitive

An independent conversation, a Project coordinator, and a Project thread are all full Pi sessions. Their relationships differ; their runtime capabilities do not.

### Projects are logical, not infrastructure boundaries

A Project connects one coordinator session, thread sessions, repositories, instructions, memory, artifacts, and status. It should not imply one pod, one VM, or one shared writable checkout.

### Environment and workspace are separate

An Environment answers what can run and under which policy. A Workspace answers which files and repository state a session owns. Compute may be replaced while the Workspace and transcript remain durable.

### One authoritative personal control plane

A personal Pi Cloud Cell should have one logical control plane. Provider Agents on laptops, VMs, and clusters connect outbound to it and execute assigned sessions. Independent control planes on every provider would require distributed conflict resolution before the product has earned that complexity.

### Extension seams are product architecture

First-party Kubernetes, Git, scheduling, notifications, and future automation capabilities should use the same public interfaces available to third-party extensions. Data records who owns it and who acted from the start, so team features don't need a migration. Trusted in-process extensions are acceptable for the personal product; external process or service adapters should remain possible for stronger isolation.

### State and execution are honest

Conversation history, Project state, Workspace state, and live processes have different durability. A reconstructed session may continue from persisted state, but a killed shell command or subagent has not been resumed. Runtime attempts and interruptions should remain visible.

## Expected evolution

The architecture should leave room for, without initially implementing:

- schedules and event triggers;
- reusable automation flows;
- GitHub, GitLab, issue tracker, and chat integrations;
- artifact and document libraries;
- push notifications;
- shared organization Environments and Profiles;
- multiplayer Projects, presence, handoffs, and approvals;
- usage policy, quotas, and audit trails;
- stronger per-session isolation profiles.

These should start ordinary session turns through a common execution interface rather than introduce separate agent runtimes.

## Initial non-goals

- Building a general Kubernetes platform before the session and Project model is proven.
- Implementing organizations, invitations, or billing in the first personal product.
- Treating Kubernetes CRDs as the primary application database.
- Guaranteeing transparent migration of running processes between providers.
- Automatically promoting every thread observation into shared Project memory.
- Replacing Pi packages or project-local configuration with a Pi Cloud-only plugin format.
