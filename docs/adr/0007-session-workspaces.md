# 0007: Session Workspaces

- Status: accepted
- Date: 2026-10-18

## Context

A Session needs its own files. In v1 a Session stays on the provider it started on ([ADR 0006](0006-provider-protocol.md)), and in v2 Sessions may run in their own Kubernetes pods.

Claude Code splits this by where it runs:

- Cloud sessions each clone the repository into their own sandbox and work on their own branch. Project threads never share a checkout ([research](../research.md#claude-projects)).
- Local sessions work in a folder the user picks. For parallel sessions, the Desktop app can give each one a Git worktree of that folder instead ([Desktop](https://code.claude.com/docs/en/desktop)).

The VM plays the cloud role in v1 and the laptop plays the local one. The laptop's value is the user's own setup: existing checkouts, untracked files, local branches and tools. A fresh clone there would throw that away.

## Decision

### VM provider

- Each Session gets a fresh clone in its own directory and works on its own branch.
- The provider may keep a local mirror per repository and clone with `--reference` to save time and disk. The mirror is a cache, never a Session's working copy.

### Laptop provider

- A Session starts from a checkout the user already has. The agent's config lists the folders it may use, and the UI offers only those.
  - Amended 2026-10-21: each listed folder is a root. Any folder inside a root may be used, after symlinks are resolved, so one `--folder ~/Dev` covers every checkout under it. The agent looks for git checkouts up to four levels under each root, skipping `node_modules` and hidden folders, and offers them in the UI. A Project repository becomes a worktree of whichever of those checkouts has it as a remote.
- By default the Session gets its own Git worktree of that checkout, on its own branch, stored outside the checkout under the agent's data directory.
- The user can instead run the Session in the folder directly. Sessions sharing a folder this way are not isolated from each other, and the UI says so.

### Both

- Git credentials come from the provider's own Git setup, the same way model credentials come from its Pi auth ([ADR 0005](0005-v1-access-and-model-credentials.md)).
- The Control Plane stores the Session's `workspaceRef` (provider, kind, repository or folder, branch), not a path.

## Consequences

- VM Sessions can't interfere with each other through Git state, and the shape maps onto one volume per Session pod in v2.
- Laptop worktrees share the checkout's `.git`, so hooks, `gc` and branch names are shared with the user's own work, as in Claude Code Desktop.
- Worktrees don't contain gitignored files such as `.env`. Copying selected ones in is left for later.
- A Session's work leaves its provider only when it is pushed.
- Removing finished clones and worktrees and pruning mirrors still needs a retention rule.
