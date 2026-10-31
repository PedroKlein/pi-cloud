# 0050: Assistant permission prompts

- Status: accepted
- Date: 2026-10-31

## Context

A meta-session asks the user before a risky call ([ADR 0035](0035-meta-sessions.md#risky-tools-ask-first)). In use, that asked far too often and showed the wrong thing.

- `ask_user` has no annotations, so it counted as risky: the user had to allow the assistant to ask them a question.
- Starting a Session or a Project, creating a Profile and building a plugin are marked open-world, so they asked too.
- The card was a confirm with the tool's name, `Allow projects_create?`, and its whole input as JSON.

Claude Code asks only before calls that change things, says in words what the call will do, and lets the user allow a tool for the rest of the session ([permissions](https://code.claude.com/docs/en/permissions)).

## Decision

- Only destructive calls ask (decided 2026-10-31). A call asks unless its tool is read-only or marked `destructiveHint: false`. A tool without annotations still asks. `ask_user` is marked read-only, since asking changes nothing.
- So starting a Session or a Project, creating a Profile or an Environment, and writing or building a plugin run straight away. Archiving a Session, editing an Environment, a Profile or a Project, and making a Profile the default ask.
- The card is a permission prompt, not a confirm (decided 2026-10-31). Its title is a question in words that names what the call changes, such as Change the Environment “local”?. A toolset tool writes it with `asks`: an optional GET `lookup` whose reply names the thing, and `text`. The meta Session part gets it from the meta plugin's `asks` route. A tool without `asks` gets Let the assistant run “projects update”?.
- Below the title the card lists the call's fields as labels and values. A label is the schema property's `title`, or the field's name in words. Ids and empty fields are left out. Lists become bullets and objects `key: value` lines, so nothing is shown as JSON.
- The card offers Allow, Allow for this session and Deny (decided 2026-10-31). Allow for this session lets that one tool run without asking until the meta-session's Pi stops.

## Consequences

- This reverses ADR 0035's amendment that starting a Session or a Project, or creating a Profile, asks. Text injected into a meta-session can now start an agent, which runs without a confirm of its own, without the user seeing a prompt first. The user still sees the new Session or Project open, and both act only as the user.
- `SessionCloud` gains `askPermission`, and the protocol a `permission` prompt answered with `once`, `session` or `deny`.
- An MCP client still decides for itself, from the same annotations.
