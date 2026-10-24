# 0032: Environments and Runners

- Status: accepted
- Date: 2026-10-24

## Context

In v1, an Environment is a name for exactly one provider ([ADR 0014](0014-concept-map-and-environments.md)), and a Session never leaves the machine it started on ([ADR 0006](0006-provider-protocol.md)). v2 adds Kubernetes, isolation and batch Jobs ([vision.md](../vision.md#scope)). [open-questions.md](../open-questions.md) left open several things v2 has to settle: whether an Environment can be a pool, how its baseline is built, whether every Session gets its own pod, and how a Session moves when its machine goes away.

Claude Code's self-hosted environments are the closest prior art ([self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments)). An environment there is a named group of runners, which the API calls a `pool`. A runner is a long-lived process on your hosts. It polls a queue, claims a session with a lease, and spawns one Claude Code process per session up to its `--capacity`. It serves one owner at a time. On Kubernetes, runners are pods, and an optional autoscaling orchestrator starts them as sessions queue. If a runner stops polling, its lease lapses after about 60 seconds and the session is requeued. Anthropic-hosted environments are configuration rather than images: network access, variables, secrets and a setup script, whose result is cached as a filesystem snapshot ([cloud environments](https://code.claude.com/docs/en/cloud-environments)).

Pi Cloud's agent already works like that runner. It connects outbound, long-polls for work and hosts Sessions ([ADR 0006](0006-provider-protocol.md), [ADR 0011](0011-server-and-agent-processes.md)).

## Decision

### An Environment is configuration plus a pool of runners

- A runner is a `pi-cloud agent`. It's the same program on a laptop, a VM or a Kubernetes pod, and it joins an Environment's pool. The provider of v1 becomes one runner.
- An Environment holds its configuration and its pool. A new Session is placed on a runner in the pool that is online and has free capacity.
- Machines either already exist, like a laptop or a VM, or are created on demand, like Kubernetes pods. That is the runner's business, not the Environment's.
- A laptop is a pool of one. Its Sessions use the laptop's own checkouts ([ADR 0007](0007-session-workspaces.md)), so its runner isn't interchangeable with another one.
- Once there is more than one user, a runner serves one owner at a time, as Claude Code's do. The first Session it claims locks it to that owner. Records already carry `ownerId` ([ADR 0015](0015-plugins.md#actors-and-owners)).

### Baseline: an image and a setup script

- An Environment may name an image. Container and pod Sessions run in it, and a Pi Cloud base image is the default.
- An Environment may have a setup script. It runs on top of the image, or directly on the machine for process Sessions, and its result is cached where the runner can cache it.
- Process Sessions don't use the image.

### Environments have no revisions

- Like Profiles ([ADR 0031](0031-profiles.md)), an Environment has no revisions. Editing it rebuilds its cache, and Sessions that start or restart afterwards get the change.
- A Session records which Environment it uses. It stays fixed once the Session starts ([ADR 0014](0014-concept-map-and-environments.md)).

### Isolation

- Each Environment runs its Sessions in one of two ways:
  - **process**: each Session is its own process on the runner's machine, as in v1 ([ADR 0017](0017-process-per-session.md)). This is the default.
  - **container**: each Session's Pi process runs in a container from the Environment's image, with its Workspace mounted in. The machine needs Docker or Podman.
- Both work on any runner: laptop, VM or pod.
- A runner's capacity decides how many Sessions share it. On Kubernetes, capacity one means one pod per Session.

### Resume on another runner

- A runner holds an expiring lease on each Session it runs, renewed by its polls. The lease reuses the generation fencing of ADR 0006.
- When a lease lapses, the server starts a new generation of the Session on another runner in its Environment. The new attempt starts from the server's copy of the transcript ([ADR 0006](0006-provider-protocol.md#transcript-replication)) and a fresh Workspace on the Session's branch. A turn that was running is reported as interrupted, as it is after an agent restart today.
- A runner that can't renew its lease in time stops its Sessions itself, so two runners never run one Session.
- In a pool of one, the Session waits for its runner to come back, as v1 Sessions do.
- Uncommitted files survive only where the Workspace survives, for example on a Kubernetes volume (below).
- pi-durable's mid-turn resume is not used. It is a separate harness that Pi packages, and so Profiles, don't run on. It has no lease of its own ("use only one process for a storage at a time"), and it doesn't keep Workspace files ([research.md](../research.md#pi-durable)).

### Kubernetes is a plugin

- Environments, pools, placement, leases, isolation and the runner are kernel. Starting runners on demand is a first-party `kubernetes` plugin, on by default, like Projects. Other sources of machines, such as cloud VMs, Fly or Nomad, would be plugins on the same seam.
- The plugin starts runner pods when Sessions queue for its Environments, and lets them exit when idle. Runners started by hand can join the same pool.
- A Kubernetes Environment has typed fields for what Pi Cloud relies on: the namespace, the capacity per pod, and where the Workspace lives. That is `emptyDir` by default, or a persistent volume claim per Session, which a replacement pod mounts again. A second claim can hold the setup cache.
- Everything else goes in a raw pod template patch that Pi Cloud passes through: node selectors, tolerations, service accounts, annotations, sidecars, resources and security context.
- A plugin for one Kubernetes flavor, such as SAP's Kyma, can build on the `kubernetes` plugin. Previews ([ADR 0022](0022-plugin-model-v2.md#previews)) become a seam a plugin can provide, so such a plugin can expose them through the platform's own routing instead of the server's proxy.

### Variables and secrets

- An Environment holds variables and secrets on the server. They are injected into the Session's environment, where the agent can read them, as environments.md's Session-readable secrets.
- Brokered secrets, attached by a proxy outside the Session, come later as their own decision.

### Network rules are deferred

- The first v2 slice has no network settings. A Session reaches whatever its machine can reach. Network rules come back once container and Kubernetes Sessions exist.

## Consequences

- Kubernetes, extra VMs and laptops are all pools of the same runner, so Projects, Sessions and the API keep their shape, as ADR 0014 intended.
- Batch Jobs can be Sessions in an Environment whose runners have capacity one and exit when done.
- ADR 0006's "a Session stays on its provider" now holds only for pools of one. Elsewhere, a Session can move to another runner, and a moved Session loses uncommitted work unless its Workspace is on a volume.
- Server-held secrets put real secret values in the server's store, which needs care once authentication arrives.
- Containers need Docker or Podman wherever an Environment uses them. Kubernetes needs a cluster account for the plugin.
- Nothing stops a Session's network traffic yet, on any runner.
