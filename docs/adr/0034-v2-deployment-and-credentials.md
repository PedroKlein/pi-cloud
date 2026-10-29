# 0034: v2 Deployment and Credentials

- Status: accepted, amended 2026-10-29 (a fork starts from a chosen user message, as Pi's `/fork` does; a clone fork from an unpushed branch fails with a clear reason)
- Date: 2026-10-24

## Context

ADRs [0031](0031-profiles.md), [0032](0032-environments-and-runners.md) and [0033](0033-v2-authentication-and-order.md) decide what v2 builds and in which order. Before building, a few gaps were left:

- v1 Sessions clone and push with the machine's own git login ([ADR 0021](0021-pull-requests.md)). A fresh container or pod has none.
- The server runs as a binary under systemd on the VM ([ADR 0009](0009-vm-deployment-and-testing.md)). Once the SSH tunnels go away it has to run somewhere reachable, with HTTPS, a first user and secrets on disk.
- ADR 0031 doesn't say what a fresh install's Profiles look like.
- vision.md's v2 list had items that ADR 0033's build order leaves out.

## Decision

### Git credentials

- A runner gets git credentials from its Environment's secrets. A token secret, such as `GH_TOKEN`, is set up as a git credential helper for the Session, so it can clone private repositories and push its branch.
- The agent can read the token, like any Environment secret ([ADR 0032](0032-environments-and-runners.md#variables-and-secrets)). A GitHub App that mints short-lived tokens can replace it later, with brokered secrets.
- Amended 2026-10-28: per-person connections from the `git-hosts` plugin win for their host, and `GH_TOKEN` stays a github.com fallback ([ADR 0043](0043-git-hosts.md)).

### The server on Kyma

- When the tunnels go away, Pi Cloud runs on SAP's Kyma. It moves there with step 3, authentication.
- It ships as a container image and a Helm chart. The chart runs one replica, because the store is SQLite, with a ReadWriteOnce volume for the data directory.
- HTTPS ends in front of the server, in Kyma's gateway (an APIRule), for the main host and the wildcard preview host ([ADR 0022](0022-plugin-model-v2.md#previews)). The server itself stays plain HTTP. Other installs put any reverse proxy in front.
- The VM and the laptop stay runners and connect out to the server, as agents do today ([ADR 0006](0006-provider-protocol.md)).

### First user

- A server with no users prints a one-time setup link with a random token to its log. Opening it creates the first user, and the token stops working.

### Secrets at rest

- Environment secrets are encrypted with AES-GCM before they are stored. The key comes from an environment variable. The Helm chart generates it as a Kubernetes Secret, and the VM reads it from a file.
- A copied database or backup doesn't contain secret values.

### Profiles start empty

- A fresh install has no Profile content to import. Profiles are created and improved by hand ([ADR 0031](0031-profiles.md)).
- Extensions every Session must have, like pi-subagents, are Session parts of Pi Cloud plugins ([ADR 0030](0030-subagents.md)), which always load whatever the Profile holds.

### v2 scope

- Forking a Session onto another runner, starting from the server's transcript, is part of step 2. It is the resume path of ADR 0032 started as a new Session.
  - Amended 2026-10-29, by the owner's decision that a fork works like Pi's `/fork` ([Pi sessions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md)). A fork names one of the Session's user messages. The new Session's transcript is the path from the root to that message's parent, through Pi's `parentId` links, so later entries and other branches stay behind. The session header stays first. The message's text comes back in the reply as `editorText`, and the web puts it in the new Session's composer to edit, as Pi's `/tree` puts it back in the editor. A fork without a message copies the whole transcript, which is closest to Pi's `/clone`.
  - The web's Fork opens a list of the Session's user messages, newest first, with "Fork the whole Session" under it.
  - A clone gets the source's branch only from the remote. The server can't tell cheaply whether a running Session pushed it, so it doesn't check. The fork marks its start point as the source's branch, and when the runner's clone can't find that branch on the remote, the fork fails with "Push the Session's branch first" instead of git's error. A source that was archived forks from the restore point its removal recorded ([ADR 0013](0013-archive-and-workspace-lifecycle.md)).
- Enforced network policy, brokered secrets and hardened runtimes move out of v2.

### Testing

- CI installs the Helm chart on kind and runs a Session on Pi's faux model in a runner pod.
- Before merging Kubernetes work, a manual smoke test runs on Pedro's Kyma cluster with a cheap real model, as v1 does on the Mac and the VM.

## Consequences

- Any runner, including an on-demand pod, can clone and push without setup by hand. The agent can read and leak the token.
- Pi Cloud needs a container image and a chart from step 3 on, next to the VM binary.
- Kyma-specific parts (APIRule, Istio) are only tested by hand.
- Losing the master key loses every stored secret.
- A new user's first Session runs with an empty Profile plus the plugins' Session parts.
