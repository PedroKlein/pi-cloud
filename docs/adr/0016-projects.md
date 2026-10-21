# 0016: Projects

- Status: accepted
- Date: 2026-10-21

## Context

A Project is one long-running goal with a coordinator Session and thread Sessions ([concepts.md](../concepts.md#project)). [vision.md](../vision.md#scope) puts Projects in v1. [ADR 0014](0014-concept-map-and-environments.md) places a Project next to Repositories and Environments, as a peer that Sessions point at. [ADR 0015](0015-plugins.md) makes features plugins on a small kernel. Projects is the first one, and Jobs and Workflows will follow the same way.

Claude Code Projects is the reference ([research](../research.md#claude-projects), [Claude Projects](https://code.claude.com/docs/en/claude-projects)):

- The user talks to the coordinator in the Project chat, and to each thread directly.
- Each thread is a full session with its own context, its own clone of every Project repository, and its own branch.
- The coordinator sees thread reports, not every internal step.
- Project instructions reach the coordinator and every new thread.
- Project memory is a folder of files with a `MEMORY.md` index that sessions read at startup. Concurrent writes aren't locked; the last one wins.

Threads here can run on different machines, the laptop and the VM. Anything shared between them has to live on the server.

## Decision

### A default plugin

- Projects is the `projects` plugin in `plugins/projects/`. It's on by default.
- It uses only what ADR 0015 gives every plugin: server tools, events, the start request, routes, its own tables and web slots. The kernel has no Project code.
- Turning it off hides Projects. Their Sessions stay ordinary Sessions.

### Project record

- A Project has an owner, a name, instructions, a list of repository URLs, a default Environment, and its coordinator Session. It lives in the plugin's own table.
- The plugin also records each member Session with its `role`: `coordinator` or `thread`. The kernel's Session record doesn't change.
- Coordinators and threads are ordinary Sessions. They use the same session view, terminals, Changes panel and archive as an independent Session.
- Creating a Project creates its coordinator in the default Environment.
- A Project keeps one coordinator for its whole life. Pi's auto-compaction keeps its context in bounds. Anything that must survive goes in Project memory, and the current threads always come from `list_threads`. A "new coordinator" action can come later. The Project only has to point at a different Session.

### Talking to a Project

- The plugin's `nav` page is the Project page: the coordinator's session view and a list of its threads.
- The user can open any thread and type into it, the same as any Session.

### Workspaces with several repositories

A Project can span several repositories. Every Session in it, the coordinator included, gets one Workspace that holds all of them side by side, as a Claude Code cloud session does.

- A new Workspace kind, `repositories`, lists the repository URLs and an optional start point for each.
- The provider checks each repository out into `<data dir>/workspaces/<Session id>/<name>`, where `<name>` is the URL's last path segment. Two repositories with the same name can't be added to one Project.
- Each checkout is on the branch `pi-cloud/<first 8 characters of the Session id>`.
- The Session's working directory is the Workspace root, so it sees every repository.
- On the VM each checkout is a clone, as in [ADR 0012](0012-built-in-provider.md).
- On the laptop, the agent matches each URL against the remotes of the folders it advertises ([ADR 0007](0007-session-workspaces.md)) and makes a worktree of the match. A repository with no checkout on that laptop is cloned.
- Mirrors and `.worktreeinclude` from [ADR 0013](0013-archive-and-workspace-lifecycle.md) apply to each checkout.
- Archiving removes the Workspace only if every checkout in it is clean by ADR 0013's rule. Otherwise the whole Workspace stays and is flagged.
- The Changes panel shows changes per repository.
- Project Sessions never run in the user's folder directly. That mode stays for independent Sessions.

### Project tools

The plugin registers these as server tools (ADR 0015). Their filter gives them only to member Sessions, and only those for the Session's role. There are no Project-specific protocol messages.

| Tool                  | Role        | Does                                                                                                                                            |
| --------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `start_thread`        | coordinator | Starts a thread through the start request, with a title and first message. Optional: repositories (a subset), Environment, start points, model. |
| `message_thread`      | coordinator | Sends a message to a thread. It queues as a follow-up if the thread is busy.                                                                    |
| `list_threads`        | coordinator | Lists threads with title, run state, work state, Environment, branch and last activity.                                                         |
| `read_thread`         | coordinator | Reads a thread's recent messages from the server's copy of its transcript, a page at a time.                                                    |
| `message_coordinator` | thread      | Sends a message to the coordinator and starts a coordinator turn.                                                                               |
| `set_status`          | thread      | Sets the thread's work state.                                                                                                                   |
| `memory_list`         | both        | Lists memory files with size and last writer.                                                                                                   |
| `memory_read`         | both        | Reads one memory file.                                                                                                                          |
| `memory_write`        | both        | Replaces one memory file.                                                                                                                       |

### Thread reports

- The plugin subscribes to `TurnEnded` and `SessionStateChanged`. When a thread finishes a turn, it adds a short notice to the coordinator's transcript: the thread's title, its states, and its final reply, cut to a fixed length.
- A notice doesn't start a coordinator turn. It's sent as context that doesn't start a turn, which the session host delivers through Pi's `sendMessage` with `triggerTurn: false`. The coordinator reads it on its next turn.
- A change of work state sends the same kind of notice.
- `message_coordinator` is the only thread action that starts a coordinator turn.
- If the coordinator's provider is offline, the plugin keeps its notices and messages and delivers them in order once the provider polls again. [ADR 0006](0006-provider-protocol.md) rejects input to an offline provider. These come from the server, not the user, so holding them doesn't change that.
- Transcripts stay in the threads. The coordinator uses `read_thread` when a notice isn't enough.

### Thread states

- The run state comes from the Session itself: `working`, `idle`, `offline` or `interrupted`. The server derives it, so it's always true.
- The work state is set by the thread with `set_status`, or by the user in the UI: `in_progress`, `blocked`, `review_ready`, `done` or `failed`. A new thread starts `in_progress`.
- The Project page highlights `blocked` and `review_ready` threads.

### Project memory

- Memory is a set of small text files per Project, stored in the plugin's tables on the server.
- `MEMORY.md` is the index. Its content goes into the system prompt of each Project Session when it starts. Other files are read with `memory_read` when needed.
- Writes replace the whole file, and the last write wins. There is no locking.
- Each file is capped at 16 KB.
- Every write is logged with its actor (ADR 0015) and the time, so the UI can show who changed what.

### Project instructions

- A Project's instructions, and then its `MEMORY.md`, are appended to the system prompt of the coordinator and of each thread when it starts. The plugin passes them in the start request, and the session host applies them through Pi's append-system-prompt option.
- Editing the instructions affects Sessions started after the edit.

## Consequences

- A Project is a plugin with a few tables, nine tools, two event subscribers and a page. Everything else is kernel Session machinery.
- Projects is the first real test of the plugin seam. Anything it needs that ADR 0015 doesn't offer goes into the plugin context, not into a private path.
- The coordinator stays aware of conversations the user has with threads directly, and it only runs a turn when the user or a thread asks for one.
- Every Session in a Project pays for a checkout of every repository unless `start_thread` narrows them. Mirrors keep the network cost down.
- Laptop threads need each repository checked out in an advertised folder, or they clone it.
- Memory is shared and unlocked. Two threads writing one file at once lose one write, which the log shows.
- A shared file library for uploads and outputs waits for a later slice.
- Deleting or archiving a whole Project isn't decided. Its Sessions can be archived one by one.
