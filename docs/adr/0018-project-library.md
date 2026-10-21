# 0018: Project file library

- Status: accepted
- Date: 2026-10-21

## Context

[vision.md](../vision.md#v1-personal-sessions-and-projects-on-your-own-machines) puts a Project file library in v1: files the user uploads, files threads publish, and files fetched into a thread's workspace. [open-questions.md](../open-questions.md) settles it as a writable shared space on the server where the last write wins, like Project memory ([ADR 0016](0016-projects.md)).

Threads run on the laptop or the VM, and the server can't reach their workspaces. A server tool runs on the server, so it can't read or write a workspace file. Passing file content through the model as a tool argument works only for small text and costs context.

## Decision

- The library is the `library` plugin in `plugins/library/`, on by default. It has a server part, a session part and a web part.
- A session part reaches its own server routes through `request(path, init)` from the session host ([ADR 0015](0015-plugins.md)). The agent sends it to the server with the Session's generation, and the route handler gets the calling Session. Bytes go straight between the workspace and the server, never through the model.
- The library belongs to a Project. The plugin learns which Session is in which Project from the `projects.MemberAdded` event and keeps its own table of members, so it reads nothing of the `projects` plugin's tables.
- Files are stored in the plugin's SQLite tables, up to 10 MB each. A write replaces the file, and every write is logged with its actor and time.
- Session tools, given only to Project Sessions: `list_library`, `publish_file` (a workspace file into the library) and `fetch_file` (a library file into the workspace).
- The web part's Library page picks a Project, lists its files with download links, takes uploads and shows recent writes.

## Consequences

- The `request` seam is generic. Any plugin can move data between its session and server parts this way, with fencing and the caller identity handled by the kernel.
- A Project's library is only as reachable as the server. A laptop thread that can't reach the server gets an error from the tool at once.
- The library misses Projects created while it was turned off, since it learns membership from events.
- SQLite blobs keep the server to one file to back up. Large files or many versions would need a blob store later.
