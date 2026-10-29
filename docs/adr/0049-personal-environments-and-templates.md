# 0049: Personal Environments and Templates

- Status: accepted
- Date: 2026-10-29

## Context

An Environment is settings plus a pool of runners ([ADR 0032](0032-environments-and-runners.md)). Several people can already sign in ([ADR 0038](0038-single-sign-on-and-admins.md)), but every one of them sees and edits every Environment, its runners and its secret names, and can start Sessions in any of them. ADR 0032 says a runner serves one owner at a time, locked by the first Session it claims, but nothing builds that lock.

That leaves two problems.

- A Session runs as its runner's operating system user. Model logins, MCP sign-ins and git tokens reach the runner for the person who started the Session ([ADR 0043](0043-git-hosts.md), [ADR 0045](0045-server-kept-logins.md)). Two people's Sessions on one runner, a pod with capacity above one or a laptop, can read each other's credentials and files.
- An Environment never says where its runners come from. The `kubernetes` plugin adds its section to every Environment, also to a laptop's, whose Sessions work in the laptop's own folders and can never run in a pod.

Claude Code keeps environments per person and lets an organization share settings, not machines ([self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments)).

## Decision

### Every Environment is one person's

- An Environment has an owner, the person who made it, and only that person starts Sessions in it (decided 2026-10-29). Nobody shares an Environment.
- Its runners are its owner's. A runner joins with its Environment's key, which only the owner makes, or with a join key, which makes a new Environment owned by the person who made the key. So a runner never serves a second person, and ADR 0032's lock on first claim isn't needed.
- A runner pod the `kubernetes` plugin starts belongs to one Environment, and so to one person, for its whole life. A pod is never reused for someone else.
- An Environment holds its owner's own secrets and variables. Capacity above one still lets one person's Sessions share a runner.

### Templates are the shared skeleton

- Admins make templates (decided 2026-10-29). A template holds the settings an Environment can share: name, isolation, image, setup script, plain variables and where runners come from. It holds no secrets and no runners.
- Where runners come from is either machines the owner joins, or pods the `kubernetes` plugin starts. A pod template carries the plugin's settings, including the pod patch, so those stay admin-only as ADR 0038 says.
- A person makes an Environment from a template, or by joining a machine without one. Their Environment adds its own name, secrets and variables. A variable of the Environment wins over the template's.
- Templates have no revisions, like Environments. Editing one reaches every Environment made from it at its next Session start.
- An Environment page shows only the sections its source needs, so the Kubernetes section appears only on an Environment made from a pod template, and there it is read-only for everyone but admins.

### The server's own runner

- When the `kubernetes` plugin can start pods, the server runs no runner of its own (decided 2026-10-29). A Session there would share the server pod's files, which hold the sealing key. The Helm chart already leaves `builtInRunner` empty.
- Outside a cluster, the built-in runner's Environment belongs to the person the setup link made. Anyone else joins a machine of their own or uses a pod template.

### What people see

- A person sees their own Environments, runners and Sessions, and the templates.
- Admins also see everyone's Environments, runners and Sessions as metadata: name, owner, template, state, runner and Session title. They can stop, archive or delete them, and revoke a runner (decided 2026-10-29).
- Admins don't see other people's transcripts, terminals, Workspace files or variable values. Secret values stay write-only for everyone, as today.
- A Session a plugin starts belongs to the person who called it ([ADR 0038](0038-single-sign-on-and-admins.md)), so a Project's coordinator and threads are their starter's. Projects several people work in come with v3 ([vision.md](../vision.md#v3-a-teams-control-center)).

### Moving to this

- Existing Environments and their runners go to the person the setup link made.
- An existing Environment with Kubernetes settings becomes a pod template with those settings, plus one Environment made from it for that person, keeping its id so Sessions and Project defaults still point at it.
- An existing Session belongs to the person who started it, or else to the setup link's person.

## Consequences

- Credentials of two people never meet on one machine, as long as each person's runners stay on machines only they use.
- Every person on a cluster gets their own pods, so a cluster runs more pods than with a shared pool, and a template's most-pods limit applies per Environment.
- Kubernetes settings live in one admin-owned place, and people pick a template instead of filling in pod fields.
- A laptop Environment no longer shows options it can't use.
- The `kubernetes` plugin keys its settings by template, not by Environment, and the machine source seam reports an Environment's template.
- A Project's default Environment is per person now, so a Project shared by several people, in v3, needs a default template instead.
- Model aliases are per Environment and admin-only ([ADR 0019](0019-model-aliases.md), ADR 0038). Whether they move to templates is open.
