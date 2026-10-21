# 0013: Archiving Sessions and Workspace lifecycle

- Status: accepted
- Date: 2026-10-21

## Context

A Session can't be stopped or removed today. The list only grows, and every Session stays loaded on its provider until the agent restarts. Worktrees and clones stay on disk forever ([ADR 0007](0007-session-workspaces.md), [ADR 0012](0012-built-in-provider.md)). Issue #20 asks when they go.

ADR 0007 also left two things for later: a repository mirror so VM clones don't download everything, and copying gitignored files such as `.env` into worktrees.

Prior art:

- Claude Code on the web archives sessions from its session list rather than deleting them.
- Claude Code asks on exit when a worktree has changes, sweeps only clean worktrees it created after `cleanupPeriodDays`, and never sweeps worktrees the user made. It copies gitignored files listed in a `.worktreeinclude` file into new worktrees ([worktrees docs](https://code.claude.com/docs/en/worktrees)).
- OpenHands uses a disk budget, age limits and a trash folder ([research](../research.md#openhands)).

## Decision

### Archive

- A Session can be archived and unarchived. Archiving sets `archivedAt`. There is no delete in v1.
- The default Session list leaves archived Sessions out. The UI can still list them.
- Archiving aborts a running turn and unloads the Session on its provider. Its transcript stays on the server and replays read-only.
- An archived Session refuses messages and terminals.
- Unarchiving clears `archivedAt`. The provider reloads the Session idle from its transcript, the same path an agent restart takes.
- The server sends unloads in its reply to the provider's work poll, next to `start`. A provider that is offline gets them when it polls again.
- This answers "When may an idle Session unload or stop?" for v1: only when it is archived.

### Workspace removal

- Archiving also asks the provider to remove the Session's workspace, but only if it is clean. Folder Sessions never touch their folder.
- Clean means no uncommitted changes, no untracked files (`git status --porcelain` is empty), and every commit on the Session branch is on a remote branch (`git rev-list <branch> --not --remotes` is empty). Gitignored files don't count, since they can't be pushed.
- A worktree is removed with `git worktree remove`, then its Session branch is deleted. A clone's directory is deleted.
- A workspace that is not clean is kept, and the Session shows "unpushed work". The user can force the removal from the archived Session.
- The provider reports the outcome, `removed` or `kept`, and the server stores it. Removals for an offline provider wait until it polls again.
- Unarchiving a Session whose workspace was removed prepares a new one from the remote branch that holds its commits.
- There is no age sweep or disk budget in v1. One can be added later if disks fill up.

### Repository mirror for clones

- A provider keeps one bare mirror per repository URL under `<data dir>/mirrors/`.
- Before each new clone it creates or fetches the mirror, then runs `git clone --reference <mirror> --dissociate`.
- `--dissociate` copies the objects into the clone, so a clone never depends on the mirror. This saves network, not disk, and a mirror can be pruned or deleted at any time.
- Clones of the same repository take turns on its mirror. If the mirror fails, the provider logs it and clones without one.

### Gitignored files in worktrees

- When a worktree is first created, the provider reads `.worktreeinclude` at the root of the source checkout, in gitignore syntax.
- A file is copied when it matches `.worktreeinclude` and is also gitignored. Tracked files are never copied.
- This is the same file Claude Code reads, so one file serves both tools.
- Clones have no source checkout and copy nothing.

## Consequences

- No work is lost without the user asking. Dirty workspaces need the user to clean up.
- Disk use only drops when the user archives Sessions.
- The work reply gains an unload list, and the agent gains a workspace-removal step and a report back. Both stay inside ADR 0006's polling model.
- Gitignored build output in a clean workspace is deleted with it.
- A forced removal deletes unpushed work for good.
