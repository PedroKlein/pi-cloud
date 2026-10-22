# 0025: A Session that needs you

- Status: accepted
- Date: 2026-10-22

## Context

Pi stops mid-turn when it asks a person something: an `ask_user` question, an extension's confirm or select, a login step ([ADR 0024](0024-provider-login-from-the-web.md)). The Session host relays each one as an open `prompt` live surface ([ADR 0006](0006-provider-protocol.md)), and the server already keeps a Session's open surfaces to replay them.

Until now that Session looked like any other running one. Its row said Working, nobody got a notice, and a Project only counted threads that set their own work state to `blocked`. The mockups show a "Needs you" state for this, like Claude Code marks a session that waits on you.

## Decision

- A Session has `waiting: boolean`. It is true while the Session has an open `prompt` surface in its current generation. The server works it out from the surfaces it tracks, so nothing new is stored and a restart or a new generation clears it.
- The server sends a `session` event when `waiting` changes, before the live event that changed it, so an open Session view updates its badge with the prompt.
- The web shows an online Session that is waiting with a "Needs you" badge, ahead of its status. A browser notice says "Pi needs you in …" when a Session starts waiting, under the same rule as "Pi finished in …".
- Projects add a `waiting` run state. A thread that is waiting goes in the board's Needs you column whatever its work state, and the Project's "needs you" count is its blocked threads plus its waiting ones.

## Consequences

- One flag covers every way Pi asks: questions, confirms, selects and logins.
- `waiting` can't tell a question that matters from a routine confirm. If that turns out to be noise, prompts can carry a level later.
- Sessions on an offline machine show Offline, not Needs you, because nobody can answer them until the machine is back.
