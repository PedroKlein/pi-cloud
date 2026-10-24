# 0027: Pi's TUI as a view of a Session

- Status: accepted
- Date: 2026-10-22

## Context

The web draws a Session from live events and its transcript. Some of Pi only exists in its terminal UI: an extension's `ctx.ui.custom` dialogs, widgets drawn as components, editor features and keyboard shortcuts. A Session with such an extension can't use it from the web today ([ADR 0006](0006-provider-protocol.md#composer-input) rejects custom dialogs). Running `pi` in the Terminal view starts a second Pi on the same transcript, which doesn't see the hosted Session live.

The 2026-10-20 spike ran Pi's `InteractiveMode` on a virtual terminal inside the agent. It renders the real TUI, draws custom dialogs, and shows prompts sent through the SDK. It also owns the process: quitting calls `process.exit`, it adds `SIGTERM`, `SIGHUP` and `uncaughtException` handlers, Ctrl+Z stops the process group, and `/new`, `/resume` and `/fork` replace the session it shows. Changing Pi upstream isn't an option. [ADR 0017](0017-process-per-session.md) moved each Session into its own process so a view like this can't take other Sessions down with it.

Pi binds extension dialogs to one UI at a time. The web binds them in `rpc` mode. The TUI binds them to itself, and each bind runs the extensions' `session_start` again.

Claude Code makes the same split between host UI and terminal UI: its mods return element trees the host draws, and what a mod draws in the terminal doesn't show on claude.ai.

## Decision

### A third view

- A Session's views are Chat, Pi and Terminal. Pi shows Pi's own TUI for the Session, in the browser's terminal emulator.
- The Session host runs one `InteractiveMode` for its Session, on a virtual terminal, the first time the Pi view opens. It keeps running until the Session stops, so the next opening finds the same editor, scroll position and open dialog.
- The view is part of the Session host, not a plugin: it needs the host's `AgentSession` and the bindings it gives extensions, which plugins don't get ([ADR 0015](0015-plugins.md)).
- The browser opens it through the terminal socket with the reserved terminal id `pi`. The Session host serves that id itself instead of starting a shell. Terminal ids are now scoped to their Session, so every Session can use `pi`.
- While no socket is attached, the virtual terminal drops what the TUI draws. Attaching sets the size and redraws the whole screen.
- Input from the web composer and from the TUI both go to the same `AgentSession`, so each shows what the other sends.

### Dialogs follow the view

- The TUI binds the Session's extensions once, the first time the Pi view opens, through a UI context that follows the view. While a Pi view is attached, the extensions' UI goes to the TUI, so `select`, `confirm`, `input`, `editor` and `custom` dialogs open there. When it detaches, it goes back to the web.
- Opening and closing the view again doesn't bind again. Pi runs the extensions' `session_start` on every bind, and extensions post snapshots and notices there, which would land in the transcript each time.
- A dialog already open stays where it opened. One open in the TUI when its socket closes waits there until the Pi view opens again.
- The host publishes a `pi_view` live surface with whether the view is attached and the title of the dialog open in it, if any. The chat says when dialogs go to the Pi view, and offers to open it when one is waiting there.
- A dialog open in the TUI counts as waiting for "Needs you" ([ADR 0025](0025-needs-you.md)), like an open `prompt`.

### The TUI doesn't own the process

Pi Cloud reaches into a few of `InteractiveMode`'s private members, all in one module. Starting the view fails with the missing names if a Pi upgrade renames one:

- Quitting (Ctrl+D, Ctrl+C twice, `/quit`, an extension's `shutdown()`) closes the view and binds dialogs back to the web. The Session keeps running.
- Ctrl+Z shows that suspending isn't available instead of stopping the process.
- The process-wide signal and error handlers it registers are removed after it starts, so the Session process keeps its own.
- Attaching redraws the whole screen.

### One session per view

- `/new`, `/resume`, `/fork`, `/clone` and `/import` would replace the Session's Pi session underneath the web and the transcript upload. A built-in extension cancels them through Pi's `session_before_switch` and `session_before_fork` events and says to start a new Pi Cloud session instead.

## Consequences

- Extensions that only work in a terminal work in a hosted Session, and the user keeps Pi's own keys and editor.
- The first opening of the Pi view runs `session_start` once more for the Session's extensions. An extension that posts a message or starts something there does it twice.
- What an extension draws in one UI, such as a widget, stays there. The other UI shows it the next time the extension updates it. [ADR 0029](0029-extension-ui-on-the-web.md) sends widgets, footers, headers and statuses to both.
- Pi Cloud depends on `InteractiveMode` internals. A Pi upgrade can break the view, and the tests say where.
- A Session that opens the Pi view keeps its TUI in memory until it stops, and the TUI's first start can download `fd` and `rg` as Pi's CLI does.
- Settings changed in the TUI, such as the model, reach the web with the next settings event, not at once.
