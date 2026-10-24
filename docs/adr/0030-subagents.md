# 0030: Subagents in the chat

- Status: accepted
- Date: 2026-10-24

## Context

Delegating work to subagents is part of how Pi Cloud should work, not an extension each user has to find. pi-subagents is the Pi package for it. In a Pi Cloud Session it runs in rpc mode, where it launches every run in the background and reports runs to the host in a versioned JSON snapshot on its `subagent-async` widget, instead of drawing its terminal panel. [ADR 0029](0029-extension-ui-on-the-web.md) hid those lines, so a Session showed only a one-line fleet summary and the completion notice.

Claude Code shows a subagent as a card in the conversation where the agent started it: the agent, what it was asked, its progress, and its steps when you open it. Background work shows as a small indicator by the prompt.

ADR 0028 planned a `tool.<name>` chat slot for Projects. Subagents need it first.

## Decision

### Subagents are a built-in plugin

- A `subagents` plugin, on by default, loads pi-subagents in every Session. pi-subagents reads files from its own package at run time (its agents, prompts and the runner it starts for background runs), so it can't be compiled into the binary. Instead the plugin names a pinned Pi package, `npm:pi-subagents@<version>`, and the session host installs it the first time a Session starts, into `~/.pi/agent/pi-cloud/packages`, then loads it as a Pi package. It installs with the Bun that runs it (a compiled binary acts as the `bun` CLI under `BUN_BE_BUN=1`) rather than Pi's own npm install, so a machine with only the Pi Cloud binary needs no npm or Bun on its PATH. pi-subagents also starts Pi for every run, and a compiled Pi Cloud would hand it Pi Cloud's own binary, so `pi-cloud pi` runs the bundled Pi, Sessions get a `pi` launcher for it, and the plugin points pi-subagents at it with `PI_SUBAGENT_PI_BINARY` unless the user set that already. A machine that can't install it, say offline, starts its Sessions without it and logs why.
- A user's own extension that registers any of the same tools, commands or flags, such as their own pi-subagents from their Pi packages, replaces the plugin's, so their version and settings win. This is Pi's rule for replaceable built-in extensions, applied to a package.
- Its web part draws runs; the extension does the work. Pi Cloud doesn't fork or patch pi-subagents.

### Cards in the chat

- A `subagent` call that launches work shows as a card where the agent called it, not as a step in the work block: the agent, the task, the state (running, done, failed, stopped), the model, the current tool, the tool count and the time.
- The card follows its run in the live snapshot, by the run id in the call's result. Once the run leaves the snapshot, the card takes its final state from the completion notice pi-subagents adds to the transcript, so a replay shows the same card.
- Opening the card shows each child: its task, its recent messages and tool calls, and its final output. The web asks for them with pi-subagents' `/subagents-inspect-rpc` command when the card opens, and again every two seconds while the child runs.
- Other `subagent` calls, such as `status` or `stop`, show as a one-line row like a work step, with the result inside. The slot claims a tool by name, so they render next to the cards rather than inside the work block.

### The running indicator

- pi-subagents' fleet summary widget is drawn by the plugin instead, as a chip, "2 subagents running", in the place the extension puts it. Clicking it scrolls to the first running card.

### New kernel parts

- **Plugin packages.** A Session part can name Pi packages, `packages: ["npm:<name>@<version>"]`, that every Session loads, with the replacement rule above.
- **`tool.<name>` slot.** A plugin's web part can claim tool names. A claimed call is drawn by the plugin's component as its own row in the turn, after the work block, in call order. The component gets the call's id, arguments and result (text, details, failed), its status (running, done or failed), and the Session's events and `send`. It is built from the transcript, so it renders the same after a replay. A call nobody claims stays a step in the work block. Live partial results aren't passed yet, since no plugin needs them.
- **`widget.<key>` slot.** A plugin's web part can claim an extension widget key and draw it in the widget's place, with the widget's rendered lines and the Session's events.
- **Extension data.** A text widget line `PI_<NAME>_JSON:<json>`, which ADR 0029 hides, is published as an `extension_data` live event with the widget key, the name and the parsed data, or `null` when the widget is removed. It is a live surface, so a browser that connects later gets the latest. Plugins read it from the Session's events; nothing draws it.
- `/subagents-inspect-rpc` goes through the normal message command. Pi runs extension commands at once, even while the agent works, and doesn't add them to the transcript.

## Consequences

- Every Session can delegate without setup, and users who already run pi-subagents keep their own.
- The card depends on pi-subagents' snapshot and inspect formats, which are versioned. A new major version shows the plain tool step until the plugin supports it.
- An agent that calls `subagent` in a Session where the user replaced pi-subagents with something else of the same tool name gets cards only if the formats match; otherwise steps.
- The completion notice still shows in the chat after the card. The `notice.<kind>` slot from ADR 0028 can fold it into the card later.
- Projects builds its thread cards on the same `tool.<name>` slot.
