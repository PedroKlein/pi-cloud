# 0015: Plugins

- Status: accepted, amended 2026-10-21 (session parts publish plugin live events; `ask`, `changes` and `usage` parts corrected; session parts reach their own server routes; web parts are React components, [ADR 0020](0020-web-stack.md); amended 2026-10-22: session slots can send their Session a message, [ADR 0021](0021-pull-requests.md); `TurnEnded` carries the turn's transcript length; v2 direction in [ADR 0022](0022-plugin-model-v2.md); a `nav` entry can list items under it in the sidebar and its page gets the rest of the address; amended 2026-10-24: owned Sessions, an embeddable Session view and chat slots, [ADR 0028](0028-projects-around-the-coordinator.md))
- Date: 2026-10-21

## Context

Pi Cloud is meant to be a foundation that others build on, as extensible as Pi itself ([vision.md](../vision.md#small-kernel-everything-else-is-a-plugin)). [extensibility.md](../extensibility.md) says first-party features should use the same public seams a third party would, with no private paths. Nothing in the code does that yet:

- `ask_user` is wired straight into the session host.
- The Changes panel and the usage totals are wired into the server and the web UI.
- Projects would have been next, with their own protocol messages ([ADR 0016](0016-projects.md)).

Projects, and later Jobs, Workflows, integrations and team features, are features on the same seams, not kernel. Some code in each feature runs on the server, some inside the Pi session, and some in the browser.

Pi's own split is the model. Its extension API (tools, commands, events, `ctx.ui`) is what its built-in behaviour is built from. Claude Code is the same: [MCP servers](https://code.claude.com/docs/en/mcp) and [plugins](https://code.claude.com/docs/en/plugins) add tools a session can call without the session knowing who serves them.

[ADR 0008](0008-monorepo-layout.md) has a `pi-extensions/` folder for Pi packages loaded into hosted Sessions. It was never created.

## Decision

### Kernel and plugins

The kernel is what every installation needs:

- Sessions and transcripts.
- Environments and providers, and the provider protocol.
- Workspaces and terminals.
- The server tool registry, the event bus, the start request and the plugin host below.
- The web shell: navigation, the Session list, the Session view and the terminal.

Everything else is a plugin. These ship as default plugins, on unless turned off:

| Plugin   | Server part                          | Session part    | Web part                         |
| -------- | ------------------------------------ | --------------- | -------------------------------- |
| projects | tools, event subscribers, its tables | none            | nav entry, Project page, notices |
| ask      | none                                 | `ask_user` tool | none                             |
| changes  | none                                 | turn-end diff   | Session side panel               |
| usage    | none                                 | none            | header item                      |

The first version of this table put `changes` on the server. That can't work: the workspace lives on the provider, and the server has no git access to it. The diff runs in the Session and reaches the browser as a plugin live event (below). `ask` raises the kernel's questions form, which is one of the dialogs the session bridge forwards, like `select` and `confirm`. `usage` adds up the transcript entries the Session view already receives, so it needs no server part.

Projects is built as a plugin from the start. `ask`, `changes` and `usage` move out of the kernel in their own changes.

### Plugin shape

A plugin is a workspace package in `plugins/<name>/`. It has up to three parts, each optional.

- **Server part** (`src/server.ts`) exports `register(ctx)`, which runs at startup. `ctx` gives it:
  - `tools`: server tools for Sessions, described below.
  - `events`: subscriptions to kernel events.
  - `sessions`: start Sessions through the start request, send them messages (as a turn, or as context that doesn't start one), and read their transcripts.
  - `routes`: HTTP handlers under `/api/plugins/<name>/`.
  - `store`: its own SQLite tables, with its own migrations, named `<plugin>_<table>`.
  - `models`: offers models for an Environment. The kernel lists them before the machine's own models, and a Session that names no model gets the offered default ([ADR 0019](0019-model-aliases.md)).
- **Session part** (`src/session.ts`) is a plain Pi extension. The session host loads it into every hosted Session, or only into Sessions that match a filter the plugin declares. Anything a Pi extension can do, a plugin can do inside a Session. The host also hands it a small context:
  - `publish(key, data)` sends a plugin live event `{plugin, key, data}` to everyone watching the Session. The latest value per key is kept and replayed to anyone who opens the Session later, like extension widgets. It's the second generic protocol addition.
  - `askQuestions` raises the kernel's questions form.
  - A session part can also give tools that replace any extension tool of the same name. `ask` gives `ask_user` this way: a user's own terminal `ask_user` draws a `custom()` dialog, which the web can't show. The session host fails `custom()` with an error the extension can read.
  - `request(path, init)` sends an HTTP request to the plugin's own server routes as this Session. The agent forwards it to `/agent/sessions/<id>/plugins/<name>/<path>`, fenced by the Session's generation like every other Session call, and the route handler gets the calling Session and its actor. It carries bytes a tool call can't, like files ([ADR 0018](0018-project-library.md)).
  - A session part's tools are asked for once when the Session starts, and may be async, so a part can ask its server part whether this Session gets them at all.
  - `checkouts`, each git checkout in the workspace and the commit its branch started from.
- **Web part** (`web/index.tsx`, with its own browser tsconfig) exports a React component for each slot or page it claims. See the web section below.

The interfaces live in `packages/plugins/`. The server, the session host and the web app depend on it. Plugins depend only on it and on `packages/protocol/`, never on app code.

### Server tools

- A server tool has a name, a parameter schema, a filter that picks the Sessions that get it (for example, "has a Project and the coordinator role"), and a handler that runs on the server.
- When a Session starts, the session host asks the server for that Session's tools and registers them with Pi.
- A call goes up the Session's stream as `tool.call` with an id, and the server answers with a `tool.result` command ([ADR 0006](0006-provider-protocol.md)). This pair is the only protocol addition. It knows nothing about Projects.
- If the provider can't reach the server, the call fails at once with an error the model can read.
- A tool's handler gets the calling Session and its actor, so the plugin can check what the caller may do.

### Events

- The server has an in-process event bus. Kernel code publishes `SessionCreated`, `SessionStateChanged`, `TurnStarted`, `TurnEnded`, `SessionArchived` and `ToolCalled`.
- `TurnEnded` carries how many transcript lines the turn ended with, when the Session host reports it ([ADR 0006](0006-provider-protocol.md)). The server's copy of the transcript can still be behind, so a plugin that reads a turn's lines waits until the copy reaches that length. Added 2026-10-22.
- Plugins subscribe to it and publish their own events, named `<plugin>.<Event>`.
- Kernel code never calls a plugin. A feature reacts to events or serves tools, routes and model offers.
- Events are in-process and not stored in v1. Current state in SQLite stays authoritative, as [extensibility.md](../extensibility.md#domain-events) says.

### One start request

- Every new Session starts through one internal start request: actor, Environment, Workspace, model, text to append to the system prompt, and the first message. It knows nothing about Projects. A plugin that starts a Session records its own link to it in its own tables.
- The web UI's "new Session" uses it, and so do `start_thread` and any later plugin: schedules, webhooks, factories. This is the common execution request from [extensibility.md](../extensibility.md#common-execution-request).

### Web UI

- A plugin's web part claims named slots: `nav` (an entry, a page, and optional items listed under the entry, such as each Project; the page gets the rest of the address after `#plugin/<name>/`), `session.panel`, `session.header`, and the chat slots `tool.<name>`, `notice.<kind>` and `link.<scheme>` ([ADR 0028](0028-projects-around-the-coordinator.md)). The `message.<type>` renderer named here first was never built; `notice.<kind>` replaces it.
- Each slot is a React component. The web bundle imports plugins statically, so they share the app's React, its data hooks and the `packages/ui` components and tokens ([ADR 0020](0020-web-stack.md)). A plugin styles itself with the same Tailwind token classes and never brings its own colours or fonts.
- A session slot gets the Session's events and `send(text)`, which posts a message as the user, so a button can run the plugin's own Pi command ([ADR 0021](0021-pull-requests.md)).
- Its props give it what `ctx` gave it before: requests to its own routes, live events for a Session, opening a Session and navigation.
- The first version of this section had each slot export `mount(element, ctx)` and let a plugin render with anything it liked. With every v1 plugin in this repository and one design system, that only meant a second way to do everything.
- A `session.panel` or `session.header` component also gets the open Session's event stream, shared with the Session view, so it sees transcript entries and its own plugin live events without opening another connection.
- Pi extensions' own UI inside a Session (`ctx.ui` widgets, status and dialogs) is still forwarded as before. Plugin UI is a separate layer around it.

### Loading and trust

- v1 plugins live in this repository. The binary and the web bundle import them statically, so the compiled binary needs no dynamic loading.
- A config list turns plugins off. A plugin that is off registers nothing, and its tables stay untouched.
- Plugins are trusted and run in the server process, the Session process and the page, like Pi extensions do.
- The plugin interfaces are internal in v1 and may change. The public SDK and third-party plugins come in v2. Untrusted web parts can then run in a sandboxed iframe that gets the same context over `postMessage`. That iframe has its own document, so a third-party part renders on its own there, and trusted parts stay React components.

### Actors and owners

- Every Session, Project and plugin record has an `ownerId`. v1 has one user, so it always holds the same value.
- Every message, command, tool call and memory write records its `actor`: `user:<id>`, `session:<id>` or `plugin:<name>`.
- This is what multiplayer Projects and team automations need later, without a migration. Permissions and UI for more than one user are not part of v1.

### Layout

- `plugins/<name>/` replaces `pi-extensions/` from ADR 0008. A Pi extension is now the session part of a plugin.
- The mandatory session bridge stays in the kernel, inside the session host.

## Consequences

- Projects, `ask`, `changes` and `usage` prove the plugin seam with four real users before it's published.
- Adding a feature, Jobs or Workflows for example, means adding a plugin, not changing the kernel. If a feature needs something the plugin context doesn't offer, the context grows, and so does every later plugin's.
- Moving `ask`, `changes` and `usage` out is extra work that doesn't change behaviour.
- The protocol grows by one generic pair of messages and one generic live event instead of one per feature.
- Plugins can break each other's UI or slow the server, because v1 has no isolation between them.
- In-process events are lost on restart. A plugin that needs to catch up reads current state from the store.
