# 0028: Extensions' terminal widgets, header and footer on the web

- Status: accepted
- Date: 2026-10-24

## Context

Pi extensions draw around the editor with `ctx.ui.setWidget`, `setFooter`, `setHeader` and `setStatus`. A widget is either lines of text or a factory that returns a TUI component, and a footer or header is always a component. A component renders itself into styled lines for a given width (`render(width): string[]`) and asks for a redraw with `tui.requestRender()` when it changes.

Pi's rpc mode, which the web binds to ([ADR 0006](0006-provider-protocol.md)), forwards text widgets and statuses and drops the rest. So the web showed text widgets with their colours stripped, and nothing at all for component widgets, custom footers and headers. Status bars and focus panels that look right in the Pi view ([ADR 0027](0027-pi-tui-view.md)) were missing or broken in the chat. Extensions also write machine-readable lines into text widgets for rpc hosts, such as pi-subagents' `PI_SUBAGENT_ASYNC_JSON:` snapshots, which the web printed as they were.

Changing Pi isn't an option, and extensions shouldn't need a Pi Cloud API for what they already draw in the terminal.

## Decision

### The Session host renders components

- The Session host takes `setWidget`, `setFooter`, `setHeader` and `setStatus` itself. It builds component factories with Pi's theme and a headless TUI, and renders them to lines the way the TUI does: a text widget is padded `Text` lines, cut at 10 lines with Pi's "widget truncated" note.
- A footer factory gets a footer data provider with the extensions' statuses, the git branch of the Session's working directory and the number of providers with models.
- When a component asks for a redraw, the host renders again, at most every 250 ms, and publishes only what changed.
- Lines keep their colours and styles (SGR escape codes). Other escape sequences, such as cursor moves and hyperlinks, are removed.
- Lines that start `PI_<NAME>_JSON:` are for hosts, not people, and are left out of text widgets.

### The web says how wide

- The web measures how many monospace columns fit across the composer and sends a `ui_columns` command when that changes. The host renders at that width, 100 columns until a browser says. With two browsers open, the last one to report sets it.

### Where the web draws them

- `widget` events keep their placement, above or below the composer. `footer` and `header` are new live surfaces with the rendered lines, or `null` when the extension removes them.
- A custom footer replaces the status row under the composer, as it replaces Pi's built-in footer in the TUI. Without one, the status row shows the extensions' statuses.
- A header shows above the conversation.
- The web draws these as terminal text: monospace, not wrapped, with the escape codes mapped to colours, bold, dim, italic, underline, strikethrough and inverse. Colours use the same 16-colour palette as the Pi view's terminal.

### Both UIs get them

- While the Pi view is attached, the extensions' widgets, footer, header and statuses go to both the TUI and the web, not only the TUI. Dialogs still follow the view ([ADR 0027](0027-pi-tui-view.md#dialogs-follow-the-view)).

## Consequences

- Extensions that draw status bars, panels and footers in the terminal show the same thing in the chat, with no changes on their side.
- Components that draw on a timer, such as spinners, cost a live event per change, at most four a second.
- A component built for one UI runs twice while the Pi view is attached, once for each.
- Pi's theme is chosen for a dark terminal. In the web's light theme, extension colours can be hard to read, as they are in the Pi view.
- The width is the composer's, not each browser's. A narrower browser watching the same Session sees lines cut off.
- Components that react to keys or the mouse, such as `ctx.ui.custom` dialogs and custom editors, still only work in the Pi view.
- What extensions write for rpc hosts, such as pi-subagents' snapshots, needs its own view. That is separate work.
