# 0028: Projects around the coordinator

- Status: accepted
- Date: 2026-10-24

## Context

[ADR 0016](0016-projects.md) made the coordinator and its threads ordinary Sessions. They show in the Session list next to independent Sessions, and the Project page is a dashboard: the coordinator's last reply, a small composer, a board of threads, settings and memory. The full coordinator chat opens as a normal Session page, outside the Project.

That isn't how a Project should feel. In [Claude Code Projects](https://code.claude.com/docs/en/claude-projects) the Project chat with the coordinator is the Project. Threads don't appear among ordinary sessions. They show inside the Project, the coordinator's replies link them by name, and a click opens one.

The kernel has no Project code ([ADR 0015](0015-plugins.md)). Hiding a Project's Sessions, sending links to them into the Project, and drawing thread cards in a chat all need seams that any plugin can use. Jobs and Workflows will start Sessions the user doesn't want in the main list either.

## Decision

### Owned Sessions

- A Session can have an owner, `{ plugin, key }`. Only a plugin's server part can set it, through the start request. Projects sets `{ plugin: "projects", key: <Project id> }` on its coordinator and every thread. Users and the public API can't set or change it.
- The Session list, the sidebar and the default `GET /api/sessions` leave out owned Sessions. The API takes an `owner` filter, and the plugin context gets `sessions.list({ owner })`.
- The owning plugin's web part says where each of its Sessions opens. Search results, browser notices and `/sessions/<id>` links for an owned Session go there, so a thread opens inside its Project.
- If the owning plugin is turned off, its Sessions come back in the Session list with a tag naming the plugin, so nothing is lost. This replaces ADR 0016's "their Sessions stay ordinary Sessions".
- `sessions.archive({ owner })` and `sessions.unarchive({ owner })` archive or bring back every Session one owner holds.

### A Session view plugins can embed

- The web shell lends plugins its Session view as a component: chat, composer, prompts, the Pi and Terminal views, the Changes panel and the header. A plugin page passes the Session id and a layout, `full` or `side`.
- The Project page uses it for the coordinator chat, the thread side panel and a fullscreen thread. None of that is rebuilt in the plugin.
- Third-party web parts in v2 are React components in the page too ([ADR 0022](0022-plugin-model-v2.md#trust)), so they embed the same view.

### The Project page

- The page is the coordinator's full chat, through the embedded Session view.
- A rail on the right lists the Project's threads. It can be collapsed. On a phone it's a drawer opened from the header, like the Session drawer.
- The rail groups threads by state: Needs you, Working, Review, then Idle. Done and Failed fold into a closed "Finished (n)" group at the bottom. A row shows the title, a state dot, the Environment and the last activity, and its ⋯ menu sets the work state or archives the thread. Needs you follows [ADR 0025](0025-needs-you.md).
- Clicking a thread opens it in a side panel next to the coordinator chat. The panel can go fullscreen, where the thread fills the page like a normal Session under a "Project › thread" header, and back. The address keeps the open thread and its layout, so a link or a reload shows the same thing.
- The user can type into the thread there, as before. The coordinator keeps getting the thread's notices.
- Settings and memory move behind a gear in the page header.
- The rail replaces the threads board. The board's Needs you and Review columns become the first two rail groups.
- The sidebar lists each Project once, with its Needs you count, and never its Sessions.

### Threads in the coordinator chat

- A `start_thread` call shows as a thread card instead of a work block: the title, its live state, the Environment, the branch, and buttons to open it in the side panel or fullscreen.
- A `message_thread` call shows as a smaller card: "→ thread title" and the first line of the message.
- A thread's turn notice shows as one slim row, "⟲ title · state", that expands to the thread's reply. Notices are input for the coordinator, so they stay quiet, and the coordinator's own reply follows them.
- The coordinator links a thread as `[title](thread:<Session id>)`. The chat draws it as a chip with the thread's live state, and a click opens the thread like a card does. The coordinator's prompt tells it to link threads this way, and `list_threads` gives it the ids.

### New web slots

The chat gets three generic slots. Projects is their first user.

| Slot            | Gets                                                   | Projects uses it for                   |
| --------------- | ------------------------------------------------------ | -------------------------------------- |
| `tool.<name>`   | a tool call, its arguments and result, live as it runs | `start_thread`, `message_thread` cards |
| `notice.<kind>` | a server notice the plugin sent, with its data         | thread report rows                     |
| `link.<scheme>` | a link's target and text in rendered markdown          | `thread:` chips                        |

- A plugin claims only its own tool names, notice kinds and link schemes. A tool call without a renderer stays a work block, and an unknown scheme stays plain text.
- `sessions.send` and `sessions.notify` take an optional notice kind and data. The session host stores them on the custom message, so the notice renders the same after a replay. This replaces the `message.<type>` slot ADR 0015 named but never built.

## Consequences

- Project Sessions leave the main list. The Project page becomes the one place to talk to the coordinator and its threads.
- The kernel grows an owner field, a list filter, owner-wide archive, an embeddable Session view and three chat slots. Each is generic, and Jobs and Workflows can use them later.
- A Project's archive is now defined: it archives every Session it owns, removes clean workspaces under [ADR 0013](0013-archive-and-workspace-lifecycle.md), and keeps the rest flagged. The Project moves to an Archived list on the Projects page, and unarchiving brings back the Project and its Sessions. Memory and settings are kept.
- Existing coordinators and threads get their owner from the plugin's member table in a migration.
- Links to a coordinator's old Session page still work, because they now open the Project.
- The board, the last-reply panel and the separate coordinator composer are removed.
