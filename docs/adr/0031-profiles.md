# 0031: Profiles

- Status: accepted, amended 2026-10-25 (a built-in read-only meta Profile for meta-sessions, [ADR 0035](0035-meta-sessions.md)), amended 2026-10-26 (a Profile is a Pi agent folder in the config folder, owned or shared, [ADR 0041](0041-profiles-as-folders.md))
- Date: 2026-10-24

## Context

Every Session today runs with the Pi setup of the machine it runs on. The agent hands the session host that machine's Pi agent directory, usually `~/.pi/agent`. [ADR 0014](0014-concept-map-and-environments.md) left Profiles for v2. So a Mac Session gets the extensions the user installed there, a VM Session gets whatever someone installed on the VM by hand, and a fresh Kubernetes pod would get nothing. [vision.md](../vision.md#personalization-is-portable) wants the user's Pi available in every hosted Session.

Pi already has a way to share customizations. A [Pi package](https://pi.dev/packages) bundles extensions, skills, prompt templates and themes, and installs from npm or git. A package can't carry the system prompt (`SYSTEM.md`, `APPEND_SYSTEM.md`), `AGENTS.md` or settings such as the default model. Those are files in the agent directory or the project. It can only include another package by bundling it into its own tarball. So one package can't describe a whole setup.

The earlier docs planned versioned Profiles: each change makes a revision, and a Session records the revision it used. Pi itself has no such thing. Editing `~/.pi/agent` takes effect the next time Pi starts.

## Decision

### A Profile is defined on the server

- A Profile is a record on the server, edited on a Profiles page. It is the server's version of a Pi agent directory without credentials:
  - the Pi packages to install, each from npm or git, pinned or not as in Pi's own settings, with Pi's optional filters for which resources to load;
  - the text of `AGENTS.md`, `SYSTEM.md` and `APPEND_SYSTEM.md`;
  - MCP servers;
  - Pi settings, such as the default model and thinking level.
- A Profile has an `ownerId`, like every other record ([ADR 0015](0015-plugins.md#actors-and-owners)).
- Pi Cloud ships one built-in Profile users can't edit, the meta Profile. Every meta-session runs on it, and only meta-sessions do ([ADR 0035](0035-meta-sessions.md)). It is picked by the meta-session itself, never by the order below.
- A Profile has no revisions. It works like Pi's agent directory: a Session's Pi process loads what the Profile holds when it starts, and loads it again when it restarts.

### Sessions and Profiles

- A Session records which Profile it uses. The choice is fixed when the Session starts and can't change afterwards.
- A new Session's Profile is picked in the same order as its Environment ([ADR 0014](0014-concept-map-and-environments.md#environments-in-v1)): an explicit choice on the Session, then the Project's default Profile, then the user's default Profile. `start_thread` can name one.
- Every provider runs Sessions with their Profile, the laptop included. A machine's own `~/.pi/agent` is never read or changed, so the user's local Pi stays separate from Pi Cloud.

### On the machine

- Each machine keeps one Pi agent folder per Profile in Pi Cloud's data directory. When a Session starts, the agent syncs that folder with the server's Profile, writing the files and settings and installing packages only when the package list changed.
- Sessions on the same Profile share its folder, as Pi processes share `~/.pi/agent`. One Environment can therefore run Sessions with different Profiles, which matters if Environments become pools later.
- A package that fails to install or load stops the Session from starting, with an error that names it, as a failed extension already does ([ADR 0010](0010-session-host-on-bun.md)).
- Provider logins are not part of a Profile. Each machine keeps them in Pi Cloud's own auth file in its data directory, separate from `~/.pi/agent/auth.json`. `/login` from the web writes there ([ADR 0024](0024-provider-login-from-the-web.md)), so a machine is logged in once for all its Profiles.

### Repository configuration

- A repository can carry its own Pi configuration in `.pi/`. Pi loads it only after project trust, because it can run code. `AGENTS.md` loads either way.
- Pi Cloud asks once per repository, in the web, the first time a Session works in it, and keeps the answer on the server. The session host gives the answer to Pi as its project trust decision.
- Repositories added to a Project count as trusted, so threads a coordinator starts never wait on the question.
- On top of the Profile, configuration follows Pi's own precedence: the Profile is the personal configuration, a trusted repository's `.pi` is the project configuration, and the Session's own picks such as model and thinking level come last. Pi Cloud plugins' Session parts always load. The installation policy and Environment overlays listed in [extensibility.md](../extensibility.md#profile-model) are not built.

### Sharing

- Parts of a setup are shared as Pi packages, the way the Pi community already shares them. These packages work in plain Pi too.
- A whole Profile is shared by exporting it as one file and importing it from a file or a git URL. An import is a copy the importer owns. A Profile can't extend another one.
- Profiles are separate from Pi Cloud plugins. A plugin extends Pi Cloud, and a Profile configures Pi ([extensibility.md](../extensibility.md#two-extension-systems)).

## Consequences

- A Session behaves the same on any machine whose Environment can install its Profile's packages.
- Editing a Profile reaches a running Session only when its process restarts, exactly as editing `~/.pi/agent` reaches Pi. A Session's transcript doesn't record which packages it loaded at each start.
- The laptop no longer uses the user's local Pi setup. They create a Profile with the packages they want, and log each machine in once more.
- A Profile change can break new Sessions, for example with a package that doesn't build on an Environment, and the Session's start error says which.
- A repository table now has something hanging off it, the trust answer, which ADR 0014 said would justify one.
- Required versus optional packages, and a Session theme taken from its Profile, are not decided here.
