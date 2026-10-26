# 0041: Profiles as Folders

- Status: accepted
- Date: 2026-10-26

## Context

[ADR 0031](0031-profiles.md) made a Profile a record on the server: one JSON value per row in SQLite, holding a package list, the text of `AGENTS.md`, `SYSTEM.md` and `APPEND_SYSTEM.md`, MCP servers and Pi settings. When a Session starts, the agent rebuilds a Pi agent folder from that value. ADR 0031 came before [ADR 0039](0039-plugin-config-files.md), and nothing about a Profile needs a database.

That shape has two limits. A Profile can only hold those fields, so a skill, a prompt template or a small extension someone wrote has to be published as a Pi package first. And a Profile can't be set up ahead of time, read on the server or kept in Git, which is what ADR 0039 says config files are for.

Pi already has a format for all of this: its agent folder, `~/.pi/agent`.

## Decision

### A Profile is a Pi agent folder

- Each Profile is a folder in the server's config folder, at `<config-dir>/profiles/<id>/`. The folder's name is the Profile's id, and Sessions record it.
- The folder holds anything Pi reads from `~/.pi/agent`: `settings.json` with its packages, `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `mcp.json`, and the `skills/`, `prompts/`, `extensions/` and `themes/` folders (decided 2026-10-26).
- Credentials, Session history and installed package caches are never part of a Profile. `auth.json` and `sessions/` in the folder are ignored, as are the folders Pi installs packages into. Provider logins stay per machine, as ADR 0031 says.
- A `profile.json` next to Pi's files holds Pi Cloud's own fields: the display name and the owner. Pi ignores it.
- A Profile still has no revisions. Edits reach a Session the next time its Pi process starts.
- Renaming a Profile changes its display name. Renaming its folder is refused while Sessions use it.

### Owners and the default Profile

- A Profile either has an owner or is shared (decided 2026-10-26).
- A Profile made in the UI gets its creator as `owner` and is private to them, as today. A folder whose `profile.json` names no owner, or that has no `profile.json`, is shared with every user.
- Only admins create, edit and delete shared Profiles.
- The server creates a shared Profile named `default` on start when it doesn't exist. It starts empty, which is a plain Pi install, and admins change it like any other shared Profile (decided 2026-10-26).
- A new Session's Profile is still picked as ADR 0031 says: the Session's own choice, then the Project's, then the user's default, which is `default` until the user picks another. Which Profile is each user's default is state the product creates as it runs, so it stays in SQLite.
- The built-in meta Profile ([ADR 0035](0035-meta-sessions.md)) ships with Pi Cloud and isn't a folder in the config folder.

### On the runner

- The server hashes a Profile folder's contents and sends the hash with each Session it assigns. The runner downloads the folder's files in one response only when the hash differs from its copy's (decided 2026-10-26).
- The runner replaces each file whole and removes the files the Profile no longer has, so Sessions already running never read half a file and the packages it installed stay. Then it installs the packages `settings.json` lists that it hasn't installed yet, as it does today.
- A folder over 20 MB is refused, with an error that names the Profile. A local extension that needs dependencies is shipped as a Pi package instead.

### Editing

- The Profile page in Settings shows the folder's files, with a text editor for any of them and buttons to add, rename, delete and upload files. An upload can be a `.zip`, such as the contents of someone's own `~/.pi/agent` (decided 2026-10-26).
- The package list and the `AGENTS.md` editor stay as shortcuts. They edit `settings.json` and `AGENTS.md` underneath.
- The server writes each file to a temporary file and renames it over the old one. Edits made by hand on the server show up the next time the page loads, and reach Sessions by the hash.
- Secrets in `mcp.json` follow ADR 0039: sealed with the server's secret key when typed in the UI, or named by an environment variable in files written by hand.

### Sharing

- Export is a `.zip` of the folder without `profile.json`. Import from a file or a git URL makes a new folder the importer owns. Import from git takes a repository whose root is a Profile folder.
- A Profile still can't extend another one.

### Moving existing Profiles

- On its first start with this change, the server writes each Profile in SQLite out as a folder named after it, made unique with a suffix when two names clash, with its owner in `profile.json`. Sessions, Project defaults and user defaults are pointed at the new ids, and the `profiles` table is dropped.
- An empty Profile named `Default`, which the server made for each user so far, isn't written out. Whatever pointed at it points at the shared `default` instead.

### Helm

- The chart doesn't seed Profiles. The `default` Profile lives on the data volume with the rest of the config folder, and admins edit it in the UI or on the volume.

## Consequences

- A Profile looks like `~/.pi/agent`, so people can copy their own setup into it, and a Profile folder can be read, diffed or kept in Git by hand.
- Skills, prompts and small extensions work in a Profile without publishing a package.
- Shared Profiles let an admin set one Pi setup for everyone. Per-user Profiles keep working as before.
- Runners download a Profile only when it changed, but a big folder costs every runner that starts a Session with it.
- A fresh install can't come up with Profiles set from Helm values. That can be added later the way ADR 0039 seeds `pi-cloud.json`.
- ADR 0031's Profile record, its SQLite storage and its per-user empty `Default` Profile are replaced. The rest of ADR 0031 stands.
