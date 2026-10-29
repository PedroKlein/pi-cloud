# 0022: Plugin Model for v2

- Status: accepted, amended 2026-10-22 (views the agent can use) and 2026-10-24 (no browser plugin yet; plugins per installation; channels deferred; Session tabs and code blocks first; no iframe for web parts; changing plugins restarts the server; amended 2026-10-25: in-place plugins in a local folder, [ADR 0035](0035-meta-sessions.md); settings, the manifest for built-ins and load failures built as [ADR 0036](0036-plugin-settings.md); capabilities name parts of `ctx`, the binary's `import()` was checked, web parts get shared modules from a global, and Session parts are fetched per Session, step 6) and 2026-10-29 (built-in plugins declare `capabilities` too; `requires` waits for a plugin that needs it)
- Date: 2026-10-22

## Context

[ADR 0015](0015-plugins.md) gives v1 an internal plugin interface with server, Session and web parts, and the default plugins prove it. v2 publishes that interface for third parties ([vision.md](../vision.md#scope)). Before freezing anything, two questions need an answer: what a third party is missing today, and what a customizable host does that ours doesn't.

The first test case was an integrated browser like the one in [Claude Code Desktop](https://code.claude.com/docs/en/desktop). It is a tabbed browser pane in the session. Claude starts the dev server from a `launch.json`, then takes screenshots, inspects the DOM, clicks and types to check its own changes. The user can browse in the same pane, pick an element to point Claude at, keep cookies, and approve external sites one by one.

Built on today's seams, that plugin runs into five gaps:

- Nothing goes from a web part to its Session part. A web part can only call its own server routes, and the server can't call a Session part. `send(text)` from [ADR 0021](0021-pull-requests.md) runs a Pi command, which is input to the Session, not a channel.
- `publish` keeps only the latest value per key and replays it. That suits state, but a live screen needs a stream.
- Nothing reaches a port inside the Workspace, such as a dev server on `localhost:3000`, from the user's browser.
- A web part can add a page, a side panel or a header item, but not a tab next to Chat and Terminal.
- Plugins have no commands, keybindings or settings.

[Obsidian](https://docs.obsidian.md/Reference/TypeScript+API/Plugin) is the comparison for customizability. A plugin is a manifest and one class. Everything it registers (views, commands, settings tabs, events, intervals, markdown code block processors, editor suggestions) is removed when the plugin turns off, with no restart. Built-in features are "core plugins" on the same API. Community plugins install from GitHub releases and are not sandboxed: Obsidian ships them off by default (Restricted mode) and scans every version ([plugin security](https://obsidian.md/help/plugin-security)). Obsidian's plugins live in each vault and run on each user's device, so every user picks their own. VS Code, Claude Code mods, JupyterLab and Figma were compared too, and the decisions below borrow from them.

## Decision

v1 code doesn't change because of this ADR. Each part below is built when v2 needs it, through its own change, and may be amended then.

### No browser plugin yet

- The first version of this ADR ran headless Chromium in the Environment and showed it to the user as a CDP screencast. A screencast is a stream of JPEG frames, not a real page: text is soft, input lags, and there is no text selection or devtools. That isn't good enough, so it is dropped.
- A web page can't embed most sites or drive a cross-origin iframe, which is why Claude Code's browser lives in a desktop app. The web-only way found so far shows a [preview](#previews) in a real iframe and lets the agent drive it through a script the preview proxy injects. It covers only apps served through a preview, and the agent can only drive the page while a viewer has it open.
- Neither is built in v2. The browser comes back as its own decision if it is still wanted, and none of the kernel pieces below depend on it.

### Plugins are per installation

- A plugin is installed and turned on for the whole installation. When there are several users, whoever runs the server decides which plugins everyone has.
- This differs from Obsidian on purpose. A server part, or a Session part in a Session several people share, changes what everyone sees, so it can't be a personal choice. Per-user or per-Project plugins can come later if a web-only plugin needs them.
- Each user's own Pi packages, extensions, skills and themes stay personal, through their Profile ([extensibility.md](../extensibility.md#profile-model)).

### Views the agent can use

A plugin can give the agent the same view it gives the user, so the agent can work in it and show things there. Not every plugin needs this, and a view that only displays data does without it.

- The view's state lives in the plugin's Session part, or its server part, never only in the page. The agent changes it through the plugin's tools and the user through the web part. The web part draws what the Session part publishes, so both always see the same thing.
- A Session part can ask the UI to show one of its views with `cloud.reveal(view)`. Every browser watching the Session gets it as a live event the shell understands, and it isn't replayed later. A wide screen opens or focuses the tab next to the chat. A phone shows a notice with a button instead, so it doesn't pull the user away from the chat.
- What the user does in a view can reach the agent. The web part sends it to the Session as a message that starts a turn, or as context for the next turn. Context uses the same path as a server part's `sessions.notify`.

### Plugin channels, later

- A channel would be a live two-way connection between two parts of one plugin: Session and web, or server and Session. It would carry JSON or binary frames, not be stored or replayed, and be paired through the server the way terminals are ([ADR 0006](0006-provider-protocol.md)).
- Only the browser needed one, so channels are not built in v2. They are added when a plugin needs a live stream, or needs its server part to call its Session part.
- Until then, `publish` carries state from the Session part, and plugin routes carry requests from the web and Session parts to the server part.

### Previews

Previews are a kernel feature, not a plugin seam. They let the user open the app the agent is building.

- A Session can expose a port. Its Session part, a tool or the user can do it. The server proxies HTTP and WebSocket traffic to that port through the provider, the way terminals reach the Session host.
- A preview is served from its own origin, `<port>--<session>.<host>`. A previewed app's scripts must never run on Pi Cloud's origin, where they could call `/api`.
- Browsers resolve every `*.localhost` name to the loopback address, so on a localhost bind or an SSH tunnel previews need no DNS. Other binds need a wildcard DNS name, which comes with v2's authentication. Which browsers resolve `*.localhost` must be checked when this is built.
- The server checks `Origin` on `/api` requests, so a preview can't post to it either.
- The user can open a preview in a real tab or on a phone, and any plugin can link to one.

### More web slots, added in order

The web part gets these slots, in this order:

1. `sessionViews`: tabs next to Chat and Terminal in the Session view. A view the agent can use is one.
2. `codeBlocks`: renderers for a fenced code block's language in chat markdown, like Obsidian's code block processors, so a plugin can draw a ` ```mermaid ` block. It is the cheapest way for the agent to show the user something.

Later, as plugins need them: `commands` (`{ id, title, keys?, when?, run }` in a command palette, with keybindings the user can change), `statusItems`, `composerSuggest` (more trigger characters for the composer menu, like `@` and `/`), and deep links into a plugin page. `message.<type>` renderers from ADR 0015 became `notice.<kind>`, next to `tool.<name>` and `link.<scheme>` ([ADR 0028](0028-projects-around-the-coordinator.md#new-web-slots)).

Slots stay fixed and named, as in Claude Code, instead of Obsidian's free layout of splits and tabs. A fixed layout also works on a phone.

### A small manifest

A plugin's `package.json` gets a `piCloud` field:

- `id` and `version`.
- `engine`: the plugin API versions it supports, like Obsidian's `minAppVersion`.
- `parts`: the paths of its server, Session and web parts.
- `capabilities`: the parts of `ctx` its server part uses, such as `sessions` or `routes` ([extensibility.md](../extensibility.md#trust-model)). Finer names like `sessions.start` can come later, once a plugin needs one part of a service without the rest. Built-in plugins declare them too and are held to them the same way, so a missing one fails them when they register. Only `auth` stays theirs alone, as in [ADR 0038](0038-single-sign-on-and-admins.md) (amended 2026-10-29: the owner decided that built-ins reach no more of `ctx` than they declare, like installed plugins).
- `requires`: what its Session part needs on the provider, such as `git` or `chromium`. A Session part whose requirements the Environment can't meet isn't loaded, and the user is told why. Deferred: the server doesn't read it yet, and it is built with the first plugin that needs it (amended 2026-10-29).

Contributions (tools, routes, slots, commands) stay in code. Declaring them in the manifest too, as VS Code does, would mean keeping two lists in step so that code loads lazily, which this scale doesn't need.

### Changing plugins restarts the server

- Turning a plugin on or off takes effect when the server restarts, and the Settings page offers the restart. The host doesn't track and undo registrations one by one.
- A plugin may export `onEnable`, which runs once when the user turns it on, for first-time setup.
- Sessions on a separate agent, like the laptop's, keep running through the restart with the Session part they started with. Sessions on the server's built-in provider are interrupted and reload idle from their transcript ([ADR 0012](0012-built-in-provider.md)), so the restart waits for the user to confirm while any of them is mid-turn. Sessions started or reloaded later get the new set.
- Live enable and disable, like Obsidian's, can be added later without changing the plugin interface.

### Settings with a schema

- A plugin declares its settings as a small schema: string, number, boolean, one of a list, or a list of strings.
- The kernel draws the form with the same components as the questions form, on one Settings page with a section per plugin. A plugin may also give its own settings component.
- Values are stored for the installation, like the plugins themselves.
- The server part reads its values through `ctx.settings`. The Session part gets its values when the Session starts, and the web part gets them as props.

### Installing third-party plugins

- A plugin is installed from a git URL or a tarball into the data directory, pinned to the version it resolved to.
- A plugin can also live in a local plugins folder in the data directory, written in place by a meta-session or by hand, like Pi's local extensions ([ADR 0035](0035-meta-sessions.md#in-place-plugins)). It isn't pinned and starts turned off like the others.
- Install and enable are separate steps. A third-party plugin starts turned off, and only the user turns it on, like Obsidian's Restricted mode. A Session may propose a plugin but can't enable one.
- Server parts are loaded with a dynamic `import()` from the data directory, and only for plugins turned on, since importing runs their code. A compiled Bun binary can import files from outside itself, but bare imports in them resolve from the plugin's folder, so parts are bundled first.
- Web parts are built as ES modules that leave `react`, `react-dom`, `@pi-cloud/ui` and `@pi-cloud/plugins/web` out, so every plugin shares the app's React and design system. The shell hands those modules over on `globalThis.piCloudShared` rather than through an import map, because its own React is inside its bundle and has no URL to map to.
- The server serves each enabled plugin's Session part to the agent, named by content hash. The runner fetches it into the Session's own folder, which works in a container too, and checks the hash, so nobody installs anything on a provider by hand. The part is a required plugin of the Session, so a runner from before installed parts refuses the Session and says it needs an update.
- A directory of plugins can come later, and can start as a JSON list.

### Trust

- Turning a plugin on is the trust decision, as in Obsidian. The prompt that enables a third-party plugin says what it can do.
- A Session part is a Pi extension and has everything the Session's process has, as Pi extensions do. Nothing sandboxes it.
- A server part only gets the `ctx` members its declared capabilities allow. This guards against mistakes, not against hostile code, because it runs in the server process. Hostile or fragile code belongs in the external service form from [extensibility.md](../extensibility.md#trust-model).
- Every web part, first-party or not, is a React component in the page, as in ADR 0015. There is no sandboxed iframe: it would only protect against plugins that have nothing but a web part, since the same plugin's server and Session parts are unsandboxed, and it would mean a second way to write plugin UI. It can come back for web-only plugins from a directory.
- A portable element tree, like Claude Code mods, is not adopted now. It comes back with a terminal view of Sessions ([v2-ideas.md](../v2-ideas.md#extension-ui)), the one case where it pays off.

### Not adopted

- Services that plugins provide to each other (JupyterLab's tokens). Events and routes are enough until third-party plugins build on each other.
- A single `app` object that reaches everything, as in Obsidian. Plugins there depend on its undocumented parts and patch it, and updates break them. Pi Cloud's context stays narrow, typed and versioned.

## Consequences

- Any plugin can make a view the agent works in and shows the user things in. Plugins that don't need it pay nothing.
- v2 has no integrated browser. Users open the agent's dev server through previews.
- The provider protocol grows by previews, which reuse the terminal pairing. The server still can't call a Session part until channels are added.
- Previews add a second origin per exposed port and an `Origin` check on the API. That adds a constraint on how v2 authentication handles cookies and hosts.
- Each new slot is API that third parties will depend on, so slots are added only when a plugin needs them.
- Changing plugins means a server restart, which interrupts the built-in provider's Sessions. Sessions on other agents keep their Session parts until they restart.
- Everyone on an installation has the same plugins. Personal choice stays in Pi's own configuration.
- Third-party plugins can do anything the server process, the Session process or the page can. The guard is that they start turned off and the user decides.
