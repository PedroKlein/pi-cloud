# Pi Cloud Environments

> Status: working model. Environment is an agreed product concept; its provider cardinality, build system, schema, and migration rules remain open.

## Purpose

An Environment is a reusable execution definition selected when a Session starts. It is not a Project, Runtime, Workspace, or live pod.

It answers:

- what runtime baseline the Session needs;
- which setup should be applied;
- what network policy should hold;
- which variables and secret references are available;
- how much compute and storage it requests;
- which isolation mode it requires;
- which Workspace implementation it uses;
- which Runtime Providers are compatible.

A Runtime is a live realization of an Environment. A Workspace contains one Session's files. A Project may choose default Environments for new Sessions.

## Provider types

The same Control Plane should support Environments backed by different provider adapters.

### Local Environment

A local Provider Agent runs ordinary processes or SDK Sessions and creates local Git worktrees. It can use local databases, emulators, keychains, Docker, and developer tools. Network policy may be advisory unless a local proxy or sandbox enforces it.

### VM Environment

A VM Provider Agent runs persistent processes or containers on an always-on host. It can retain repositories and build caches and may be the cheapest place for coordinator and long-running personal Sessions.

### Kubernetes Environment

A namespace-scoped Provider Agent creates or selects shared runners, dedicated Session pods, or Jobs. Kubernetes can enforce images, resources, security contexts, service accounts, node placement, volume mounts, and some network policy.

### Self-hosted runner pool

A future provider may register a pool of interchangeable outbound-connected runners. Sessions target the Environment pool and may resume on another compatible runner after interruption.

These are adapters behind one Environment and Session interface, not separate products.

## Selection

The current working selection precedence is:

1. explicit Session or Thread override;
2. Project default Environment;
3. user default Environment;
4. installation default.

A Project may use one default for its coordinator and another for worker Threads. For example, a cheap always-on VM Environment may host the coordinator while implementation Threads run in Kubernetes or on a laptop with a required emulator.

A running Session cannot transparently switch Environments. Cross-Environment continuation requires a settled checkpoint plus Workspace transfer or reconstruction. It may initially be safer to fork a Session into the target Environment and preserve the origin relationship.

## Revisions

Environment definitions should be versioned and inspectable.

```text
Default Development
  revision 7: used by existing Sessions
  revision 8: latest and ready for new Sessions
```

A Session records its selected Environment revision. Changing setup, runtime baseline, resource policy, or other material configuration creates a new revision. Archiving an Environment should prevent new assignments without erasing the revision required to explain or reconstruct existing Sessions.

Open policy questions include whether an update:

- affects only new Sessions;
- may restart idle Sessions after explicit approval;
- may migrate selected Sessions;
- may change live network policy independently of the pinned revision.

Explicit revisions make failures reproducible and avoid silently changing the meaning of an existing Session.

## Runtime baseline and setup

Claude cloud Environments distinguish cached environment setup from per-session startup. Pi Cloud should preserve that conceptual split.

### Environment setup

Used for runtime provisioning that can be shared across Sessions:

- operating-system packages;
- language toolchains;
- CLI tools;
- pulled container images;
- files and configuration that belong to the runtime baseline.

Possible implementations include:

- an immutable OCI image per Environment revision;
- a base image plus an Environment cache volume;
- Nix or devcontainer-based builders;
- host setup validation for local or VM providers.

Immutable OCI images are attractive for reproducibility in Kubernetes. A cache-volume prototype may be easier initially. No builder has been selected.

### Session startup

Runs whenever one Session starts or is reconstructed:

- prepare or mount its Workspace;
- clone repositories or attach a worktree;
- install repository dependencies when they are not in the Environment baseline;
- start databases, containers, dev servers, or other processes;
- bind the Pi Profile and trusted project configuration.

Environment caches preserve files, packages, and images. They do not preserve running processes. Runtime reconstruction must restart Session services.

## Runtime capacity and isolation

An Environment selects or constrains an execution mode:

```text
shared-process
  several trusted Pi Sessions in one Runtime

dedicated-pod
  one full Pi Session per pod

batch-job
  bounded execution that publishes outcomes and exits

hardened
  dedicated pod or microVM with a stronger runtime boundary
```

Capacity applies to the Runtime, not to the number of Projects. One shared Runtime may host independent Sessions and Sessions from several Projects when they belong to the same owner and use a compatible Environment revision.

Sessions may share one Runtime only when their required policy is compatible. In particular, sessions with different container images, network policy, secret mounts, or security contexts should not be placed in one pod if those policies cannot be enforced per process.

## Capability validation

Provider Agents advertise capabilities. Environment creation or activation validates requested policy against them.

For example, a local provider may report:

```yaml
execution:
  - process
workspace:
  - directory
  - git-worktree
platform:
  - darwin-arm64
docker: true
gpu: false
persistentProcesses: true
networkPolicyEnforcement: false
```

A Kubernetes provider may additionally support:

```yaml
execution:
  - shared-runner
  - dedicated-pod
  - job
workspace:
  - pvc
  - ephemeral
networkPolicyEnforcement: true
runtimeClass: true
gpu: true
```

The Control Plane must distinguish strongly enforced policy from advisory configuration.

## Network policy

A user-facing model similar to Claude's is useful:

| Mode | Meaning |
|---|---|
| None | Deny Session egress except required control/model channels |
| Trusted | Allow a maintained set of package, Git, and platform endpoints |
| Custom | Allow an Environment-specific domain list, optionally plus Trusted |
| Full | Permit unrestricted egress and mark the Environment accordingly |

Plain Kubernetes NetworkPolicy is oriented around addresses rather than durable hostname allowlists. Strong domain enforcement may require an egress proxy, Cilium FQDN policy, a service mesh, or another DNS-aware layer.

A local prototype may store and display requested policy before every provider can enforce it. The UI and capability result must not confuse advisory policy with enforcement.

## Variables and secrets

Environment variables are readable by the Session and any command it runs. They must not be presented as secret storage.

Secret exposure should eventually distinguish:

### Session-readable secret

Mounted or injected into the Session process. Simple and suitable for a trusted personal Cell, but the agent can read and disclose the value.

### Brokered network secret

Stored outside the Session Runtime and attached by a controlled proxy only to matching outbound requests. The agent can use the credential without reading its raw value.

### Git credential broker

Mints or injects short-lived, repository-scoped credentials and enforces allowed Git operations without placing broad personal tokens inside the Session.

The latter two are future capabilities, but the Environment model should not classify every credential as an ordinary variable or file mount.

## Workspace policy

An Environment selects a compatible Workspace driver and defaults such as:

- local worktree root;
- VM persistence root;
- shared versus per-session volume;
- PVC size and StorageClass;
- retain, archive, snapshot, or delete policy;
- ephemeral batch checkout;
- repository mirror and cache use.

Workspace durability is separate from Runtime lifetime. Stopping a Runtime should not imply deleting a retained Workspace.

## Example shapes

These examples express the model, not a decided schema.

### Local development

```yaml
name: local-development
provider: pedro-laptop
execution:
  isolation: process
  capacity: 4
workspace:
  driver: git-worktree
network:
  mode: host
profile: pedro
```

### Always-on VM

```yaml
name: always-on
provider: home-vm
execution:
  isolation: process
  capacity: 8
workspace:
  driver: persistent-worktree
network:
  mode: host
profile: pedro
```

### Isolated Kubernetes

```yaml
name: cluster-isolated
provider: company-cluster
execution:
  isolation: dedicated-pod
  image: registry.example/pi-runtime:version
workspace:
  driver: pvc
  retention: retain
network:
  mode: custom
resources:
  cpu: 4
  memory: 8Gi
profile: standard
```

## Relationship to deployment

The Control Plane's own deployment and a Session Environment are independent. A Control Plane running on a VM may dispatch Sessions to the same VM, a laptop, and Kubernetes. A Control Plane running in Kubernetes may still dispatch a Session to a connected laptop.

This independence connects the three initial use cases without requiring three separate products or authoritative control planes.
