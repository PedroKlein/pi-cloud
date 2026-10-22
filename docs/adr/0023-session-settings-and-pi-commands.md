# 0023: Session settings and Pi's built-in commands

- Status: accepted
- Date: 2026-10-22

## Context

A Session's model is picked when it starts, and nothing in the web can change it afterwards. There's no way to set how much the model reasons either. Claude Code's composer has a model picker and an effort picker for each session, and Pi's TUI has `/model` and `/thinking`.

The web `/` menu lists extension commands, prompt templates and skills ([ADR 0006](0006-provider-protocol.md#composer-input)). Pi's built-in TUI commands aren't there. Pi runs those in its interactive mode, not in `AgentSession.prompt`, so `/compact` typed in the web composer reaches the model as plain text.

Pi's SDK has calls for most of what those commands do: `setModel`, `setThinkingLevel`, `getAvailableThinkingLevels`, `compact`, `setSessionName`, `getSessionStats` and `reload`. Pi writes `model_change` and `thinking_level_change` entries to the JSONL, and restores both when a session resumes.

## Decision

### Model and reasoning in the composer

- The composer shows the Session's model and reasoning level under the message box, like Claude Code. Each one opens a menu.
- The model menu lists what the New session form lists: the Environment's aliases first, then the machine's models ([ADR 0019](0019-model-aliases.md#choosing-a-model)).
- The reasoning menu lists the levels Pi reports for the current model (`off` to `max`). A model without reasoning shows no menu.
- A change applies from the next model request.
- The New session form gets a reasoning field next to its model field, and the start request takes an optional `thinking` level.

### Protocol

- Two commands: `set_model { model }` and `set_thinking { level }`. The Session host calls Pi's `setModel` and `setThinkingLevel`. An unknown model or level comes back as an error notice.
- A live event `settings { model, thinking, levels }` is sent when an attempt starts and after every change. It's a live surface with the key `settings`, so a browser that connects later gets the current one.
- When the server stores a `model_change` entry, it updates `Session.model`. The sidebar, the session header and the next attempt then agree with what Pi uses.

### Pi's built-in commands

The Session host lists these with `source: "builtin"` in the `commands` surface. When a message is one of them, the host runs it and doesn't send it to the model:

| Command                   | Does                                                                          |
| ------------------------- | ----------------------------------------------------------------------------- |
| `/model [provider/id]`    | Sets the model. With no argument, the web opens the model menu.               |
| `/thinking [level]`       | Sets the reasoning level. With no argument, the web opens the reasoning menu. |
| `/compact [instructions]` | Compacts the context now.                                                     |
| `/name <name>`            | Names the Session. The name becomes its title.                                |
| `/session`                | Posts the Session's stats (messages, tokens, cost) as a note.                 |
| `/reload`                 | Reloads extensions, skills, prompts and context files.                        |
| `/copy`                   | Copies the last answer. The browser does this itself and sends nothing.       |

These aren't offered:

- TUI-only commands: `/settings`, `/hotkeys`, `/changelog`, `/scoped-models`, `/trust`, `/bug` and `/quit`.
- `/new`, `/resume`, `/fork`, `/clone` and `/tree`, which would change the session behind a Pi Cloud Session. Pi Cloud's own New session and a later fork cover these.
- `/export`, `/import` and `/share`, which move files between the provider and the browser.
- `/login` and `/logout`, which [ADR 0024](0024-provider-login-from-the-web.md) adds.

## Consequences

- A Session can move to a cheaper or stronger model without starting over, and an alias stays an alias.
- Changing the model mid-session drops the prompt cache, as it does in Pi.
- Most built-in commands use the same SDK calls as Pi's own RPC mode, so they should keep working across Pi versions.
- `/export` and the session-tree commands stay TUI-only until Pi Cloud has file transfer and forks.
