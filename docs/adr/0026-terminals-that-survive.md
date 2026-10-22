# 0026: Terminals that survive their tab

- Status: accepted, amended by [ADR 0027](0027-pi-tui-view.md) (terminal ids are per Session, and `pi` opens Pi's TUI)
- Date: 2026-10-22

## Context

A Session's terminal was a shell tied to one socket ([ADR 0006](0006-provider-protocol.md)). Closing the tab, switching to Chat, a phone locking its screen or a flaky network killed the shell and whatever ran in it: a dev server, a long test run, an editor. Coming back meant a fresh shell. The mockups proposed terminals that survive, several per Session, and Claude Code's cloud sessions keep their shells the same way.

## Decision

### The Session host keeps the shell

- A shell runs until it exits, its tab is closed, or its Session generation stops. Losing the socket only detaches it.
- The browser names each terminal with an id it makes up and passes it when it opens the socket (`?terminal=<id>`). An id the Session host already runs a shell for reattaches to it; a new id starts a new shell. Ids are per Session, so two Sessions can use the same one.
- The host keeps the last 64 KB of each shell's output in memory and sends it to the next socket before live output, so the screen comes back. Nothing is written to disk and the server stores nothing.
- Opening a terminal that another socket is attached to moves it to the new socket, and the old one closes with "opened elsewhere".
- The socket's text frames are `TerminalControl`: a `resize`, or a `close` that ends the shell. Closing the socket without it leaves the shell running.

### The browser shows tabs

- The host publishes the running shells as a `terminals` live surface (id and label, "Terminal 1", "Terminal 2", …), so every browser on the Session sees the same tabs and a reload finds them.
- The Terminal view opens the first running shell, or a new one when there are none. A + button starts another, and a tab's × closes it, which ends the shell.

## Consequences

- A long-running command keeps going while nobody watches, and a phone can pick it up later.
- Shells hold memory and processes until their Session stops. There is no idle limit yet; if forgotten shells pile up, one can be added per Environment.
- 64 KB covers a couple of full screens. Output beyond that is missing from the replay, though the shell itself lost nothing. A full-screen program such as an editor may need a redraw (Ctrl-L) after a reattach.
- A replay can start in the middle of an escape sequence. xterm.js skips what it can't parse, so at worst the first line of the replay looks wrong.
