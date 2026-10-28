# 0044: Base Profile

- Status: accepted
- Date: 2026-10-28

## Context

A Pi extension can register a model provider, as a package such as an SAP AI Core provider does. Pipoca loads extensions only from a Session's Profile ([ADR 0041](0041-profiles-as-folders.md)), so three things go wrong for a provider that comes from one.

- An alias ([ADR 0019](0019-model-aliases.md)) can name the provider's models, since alias entries are plain `provider/id` text. A Session whose Profile doesn't load the extension skips those models without saying why.
- The models an Environment offers are the ones its online runners report, and a runner lists an extension's models only after it has run a Session with that Profile and only when the provider is logged in there. Kubernetes runners exit when idle ([ADR 0032](0032-environments-and-runners.md)), so the Models page usually suggests nothing.
- A runner's `--extension` flag loads an extension in every Session on that machine, but it's set per runner, Kubernetes runners can't be given it, and the UI doesn't know about it.

An admin wants some extensions in every Session, providers above all, and the same goes for skills everyone should have.

## Decision

### A base Profile under every Profile

- An admin keeps one base Profile: a Pi agent folder at `<config-dir>/base/`, with the same files a Profile has ([ADR 0041](0041-profiles-as-folders.md#a-profile-is-a-pi-agent-folder)). It isn't in `profiles/`, so nobody picks it for a Session (decided 2026-10-28).
- Every Session on every Environment loads it under its own Profile (decided 2026-10-28).
- Only admins edit it, in Settings, with the same file editor as Profiles. It starts empty.
- It never holds credentials, as a Profile never does.

### Layered as Pi layers its global and project config

The base is to the Profile what Pi's `~/.pi/agent` is to a repository's `.pi/` (decided 2026-10-28):

- Packages from both load. When both list the same package, the Profile's entry wins.
- Extensions, skills, prompts and themes from both load. When two have the same name, the Profile's wins.
- The base's `AGENTS.md` comes first, then the Profile's.
- MCP servers from both load. When both name the same server, the Profile's wins.
- `SYSTEM.md` and `APPEND_SYSTEM.md` from the Profile replace the base's.
- The other keys of `settings.json` are merged with Pi's own deep merge, the Profile's values over the base's.
- A trusted repository's `.pi` still layers over both ([ADR 0031](0031-profiles.md)).

### On the runner

- The server layers the base into each Profile's files before a runner downloads them. A Profile's hash covers the base, so an edit to either reaches runners the way a Profile edit does, and runners need nothing new. A runner installs the base's packages with each Profile's, once per Profile and machine.
- The 20 MB cap applies to the base on its own.
- The built-in meta Profile ([ADR 0035](0035-meta-sessions.md)) isn't layered, so meta-sessions stay read-only.
- A base package that fails to install or load stops the Session with an error that names it, as a Profile package does.
- The runner's `--extension` flag stays for a single machine.

### Models while no runner is online

- A runner reports every model its providers register, from the base and from each Profile it holds, and marks the ones logged in on that machine (decided 2026-10-28).
- The server keeps the last list each Environment's runners reported, so it outlives runners that exit. A runner's newer report replaces what it reported before.
- The Models page suggests every model in that list. Model pickers show the logged-in models first, and the others as needing a login.

### Credentials

- Nothing changes for v2: a provider from the base takes its key from an Environment secret, which Sessions get as an environment variable, or from a `/login` on the runner ([ADR 0024](0024-provider-login-from-the-web.md)). A login on a Kubernetes runner is lost when the runner exits.
- Per-person provider credentials, with a server-kept login per person and person-level secrets, are left for v3, since v2 serves one person (decided 2026-10-28).

## Consequences

- An admin installs a provider once and every Session can use it, so aliases that name it work everywhere.
- Shared skills and instructions live in one place instead of in every Profile.
- The Models page can suggest a provider's models after one Session has run with the base, even when every runner has since gone.
- Every runner downloads and installs the base with each Profile, so a big base slows each first Session of a Profile on a fresh runner.
- A remembered model can be gone by the time a Session asks for it. An alias already skips a model its machine doesn't have.
