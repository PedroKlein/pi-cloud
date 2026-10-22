# 0022: Plugin Model for v2

- Status: accepted, amended 2026-10-22 (views the agent can use)
- Date: 2026-10-22

## Context

[ADR 0015](0015-plugins.md) gives v1 an internal plugin interface with server, Session and web parts, and the default plugins prove it. v2 publishes that interface for third parties ([vision.md](../vision.md#scope)). Before freezing anything, two questions need an answer: what a third party is missing today, and what a customizable host does that ours doesn't.

The test case is an integrated browser like the one in [Claude Code Desktop](https://code.claude.com/docs/en/desktop). It is a tabbed browser pane in the session. Claude starts the dev server from a `launch.json`, then takes screenshots, inspects the DOM, clicks and types to check its own changes. The user can browse in the same pane, pick an element to point Claude at, keep cookies, and approve external sites one by one. It is the kind of feature Pi Cloud users should be able to build as a plugin, without changing the kernel.

Built on today's seams, that plugin runs into five gaps:

- Nothing goes from a web part to its Session part. A web part can only call its own server routes, and the server can't call a Session part. `send(text)` from [ADR 0021](0021-pull-requests.md) runs a Pi command, which is input to the Session, not a channel.
- `publish` keeps only the latest value per key and replays it. That suits state, but a live screen needs a stream.
- Nothing reaches a port inside the Workspace, such as a dev server on `localhost:3000`, from the user's browser.
- A web part can add a page, a side panel or a header item, but not a tab next to Chat and Terminal.
- Plugins have no commands, keybindings or settings.

[Obsidian](https://docs.obsidian.md/Reference/TypeScript+API/Plugin) is the comparison for customizability. A plugin is a manifest and one class. Everything it registers (views, commands, settings tabs, events, intervals, markdown code block processors, editor suggestions) is removed when the plugin turns off, with no restart. Built-in features are "core plugins" on the same API. Community plugins install from GitHub releases and are not sandboxed: Obsidian ships them off by default (Restricted mode) and scans every version ([plugin security](https://obsidian.md/help/plugin-security)). VS Code, Claude Code mods, JupyterLab and Figma were compared too, and the decisions below borrow from them.

## Decision

v1 code doesn't change because of this ADR. Each part below is built when v2 needs it, through its own change, and may be amended then.

### The browser runs next to the Workspace

- A browser plugin runs headless Chromium in the Session's Environment. Its Session part starts Chromium and drives it over the Chrome DevTools Protocol, using Bun's own WebSocket or a pipe. It doesn't need Playwright.
- The agent's browser tools (open, screenshot, click, type, read the page, console, network) call CDP directly.
- The user sees the same browser as a live screencast in a Session tab, and their clicks and keys go back as CDP input events.
- The agent can check its work while nobody has the page open, and the user can watch from a phone. A dev server is plain `localhost` for Chromium, because they share a machine.
- The cost is that Chromium must be installed in the Environment, and the user sees frames instead of a real DOM.

The kernel pieces it needs follow. Each one is generic, and none of them knows about browsers.

### Views the agent can use

The browser is one case of a wider rule: a plugin can give the agent the same view it gives the user, so the agent can work in it and show things there. Not every plugin needs this, and a view that only displays data does without it.

- The view's state lives in the plugin's Session part, or its server part, never only in the page. The agent changes it through the plugin's tools and the user through the web part. The web part draws what the Session part publishes or streams, so both always see the same thing.
- A Session part can ask the UI to show one of its views with `cloud.reveal(view)`. Every browser watching the Session gets it as a live event the shell understands, and it isn't replayed later. A wide screen opens or focuses the tab next to the chat. A phone shows a notice with a button instead, so it doesn't pull the user away from the chat.
- What the user does in a view can reach the agent. The web part sends it to the Session as a message that starts a turn, or as context for the next turn. For example, the browser's element picker tells the agent which element the user meant. Context uses the same path as a server part's `sessions.notify`.

### Plugin channels

- A plugin can open a channel for a Session: `cloud.channel()` in its Session part, `session.channel()` in its web part. A channel carries JSON or binary frames in both directions. It is not stored or replayed.
- Each channel is its own WebSocket, paired through the server the way terminals are ([ADR 0006](0006-provider-protocol.md)), and reuses that code. If the number of sockets becomes a problem, channels can share one socket per Session later.
- A slow viewer loses frames instead of buffering them without limit, as terminals already cap buffered bytes.
- The server part can open a channel to a Session part too. That closes the gap where the server can't call a Session part.
- `publish` stays for state that a viewer who opens the Session later must see.

### Previews

- A Session can expose a port. Its Session part, a tool or the user can do it. The server proxies HTTP and WebSocket traffic to that port through the provider, the way terminals reach the Session host.
- A preview is served from its own origin, `<port>--<session>.<host>`. A previewed app's scripts must never run on Pi Cloud's origin, where they could call `/api`.
- Browsers resolve every `*.localhost` name to the loopback address, so on a localhost bind or an SSH tunnel previews need no DNS. Other binds need a wildcard DNS name, which comes with v2's authentication. Which browsers resolve `*.localhost` must be checked when this is built.
- The server checks `Origin` on `/api` requests, so a preview can't post to it either.
- The browser plugin doesn't need previews, but any plugin and the user can use them, for example to open the app in a real tab or on a phone.

### More web slots, added in order

The web part gets these slots, in this order:

1. `sessionViews`: tabs next to Chat and Terminal in the Session view. The browser's tab is one.
2. `commands`: `{ id, title, keys?, when?, run }`. Commands appear in a command palette and can have keybindings the user can change. `when` hides a command where it doesn't apply, like Obsidian's `checkCallback`. These are UI commands; Pi's own slash commands stay where they are.
3. `codeBlocks`: renderers for a fenced code block's language in chat markdown, like Obsidian's code block processors, so a plugin can draw a ` ```mermaid ` block.

Later, as plugins need them: `statusItems`, `composerSuggest` (more trigger characters for the composer menu, like `@` and `/`), and deep links into a plugin page. `message.<type>` renderers from ADR 0015 are still planned.

Slots stay fixed and named, as in Claude Code, instead of Obsidian's free layout of splits and tabs. A fixed layout also works on a phone.

### A small manifest

A plugin's `package.json` gets a `piCloud` field:

- `id` and `version`.
- `engine`: the plugin API versions it supports, like Obsidian's `minAppVersion`.
- `parts`: the paths of its server, Session and web parts.
- `capabilities`: what it needs from the kernel, such as `sessions.start` or `projects.read` ([extensibility.md](../extensibility.md#trust-model)).
- `requires`: what its Session part needs on the provider, such as `chromium`. A Session part whose requirements the Environment can't meet isn't loaded, and the user is told why.

Contributions (tools, routes, slots, commands) stay in code. Declaring them in the manifest too, as VS Code does, would mean keeping two lists in step so that code loads lazily, which this scale doesn't need.

### Every registration can be undone

- The host tracks each registration a server part makes through `ctx`: tools, routes, event subscriptions and model offers. Turning a plugin off removes all of them without a restart, like an Obsidian `Component` unloading.
- A plugin may export `onEnable`, which runs once when the user turns it on, for first-time setup.
- A tool call or route request already running when the plugin turns off finishes. New ones fail with an error that names the plugin.
- Running Sessions keep the Session part they started with. Sessions started later get the new set.
- Web parts unmount when the list of enabled plugins changes.

### Settings with a schema

- A plugin declares its settings as a small schema: string, number, boolean, one of a list, or a list of strings.
- The kernel draws the form with the same components as the questions form, on one Settings page with a section per plugin. A plugin may also give its own settings component.
- Values are stored per scope. v2 starts with the installation scope. Project, Environment and Profile scopes follow with Profiles and use the same precedence as the rest of the configuration ([extensibility.md](../extensibility.md#profile-model)).
- The server part reads its values through `ctx.settings`. The Session part gets its values when the Session starts, and the web part gets them as props.

### Installing third-party plugins

- A plugin is installed from a git URL or a tarball into the data directory, pinned to the version it resolved to.
- Install and enable are separate steps. A third-party plugin starts turned off, and only the user turns it on, like Obsidian's Restricted mode. A Session may propose a plugin but can't enable one.
- Server parts are loaded with a dynamic `import()` from the data directory. Whether a compiled Bun binary can import files from outside itself must be checked when this is built.
- Web parts are built as ES modules that leave `react`, `@pi-cloud/ui` and `@pi-cloud/plugins/web` external. The shell serves an import map for them, so every plugin shares the app's React and design system.
- The server serves each enabled plugin's Session part to the agent, named by content hash. The agent caches it, so nobody installs anything on a provider by hand.
- A directory of plugins can come later, and can start as a JSON list.

### Trust

- A Session part is a Pi extension and has everything the Session's process has, as Pi extensions do. Nothing sandboxes it. The prompt that enables a plugin says so.
- A server part only gets the `ctx` members its declared capabilities allow. This guards against mistakes, not against hostile code, because it runs in the server process. Hostile or fragile code belongs in the external service form from [extensibility.md](../extensibility.md#trust-model).
- Web parts from first-party and other trusted plugins are React components in the page, as in ADR 0015. A web part the user hasn't marked trusted runs in a sandboxed iframe that gets the same props over `postMessage`, as ADR 0015 already planned. It can use any web stack, and it renders with the shell's tokens passed in as CSS variables.
- A portable element tree, like Claude Code mods, is not adopted now. It comes back with a terminal view of Sessions ([v2-ideas.md](../v2-ideas.md#extension-ui)), the one case where it pays off.

### Not adopted

- Services that plugins provide to each other (JupyterLab's tokens). Events and routes are enough until third-party plugins build on each other.
- A single `app` object that reaches everything, as in Obsidian. Plugins there depend on its undocumented parts and patch it, and updates break them. Pi Cloud's context stays narrow, typed and versioned.

## Consequences

- Any plugin can make a view the agent works in and shows the user things in, as the browser does. Plugins that don't need it pay nothing.
- An integrated browser can be built as a plugin from the generic pieces here, with no browser code in the kernel and no browser library dependency.
- The provider protocol grows by channels and previews. Both reuse the terminal pairing.
- Previews add a second origin per exposed port and an `Origin` check on the API. That adds a constraint on how v2 authentication handles cookies and hosts.
- Each new slot is API that third parties will depend on, so slots are added only when a plugin needs them.
- Plugins can be turned on and off without a restart. Running Sessions keep their Session parts until they restart.
- Third-party Session parts and server parts can still do anything the process can. The guard is that they start turned off and the user decides.
- An Environment that runs the browser plugin needs Chromium. `requires` makes the gap visible instead of failing inside a tool call.
