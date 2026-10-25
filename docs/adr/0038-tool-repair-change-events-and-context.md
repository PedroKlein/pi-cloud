# 0038: Tool Argument Repair, Change Events and the Context Meter

- Status: accepted
- Date: 2026-10-25

## Context

[LearnHarness](https://github.com/amosblomqvist/learnharness) is a learning app built on Pi's `pi-ai` and `pi-agent-core`. Several of its techniques answer problems Pi Cloud has too:

- **Models send tool arguments in the wrong shape.** LearnHarness logged one model sending an enum as a JSON-encoded string (`"mode": "\"recall\""`) 19 times in a row, because the validation error never named the allowed values. It now repairs such arguments before validation, for every tool. Pi 1.3 already turns `"3"` into `3` and `"true"` into `true`, but it rejects `"\"create\""` for an enum and `"[\"a\"]"` for an array, and its error for an enum is `must be equal to one of the allowed values`. Meta-sessions call plugin tools with whatever model the user picked ([ADR 0035](0035-meta-sessions.md)), and the smoke tests run on a small Gemini model.
- **Lists poll.** The web reloads the Sessions, Profiles, Environments, Plugins and MCP token lists every 2 seconds, Projects every 3 and meta-sessions every 5. LearnHarness replaced its polls with one stream that only says that something changed; each view then fetches as usual.
- **Nothing shows how full the context is.** The `usage` plugin shows a Session's tokens and cost. Claude Code and LearnHarness also show how much of the model's context the conversation fills.
- **Nothing keeps plugins on the SDK.** Built-in plugins import only `@pi-cloud/plugins`, `@pi-cloud/protocol` and `@pi-cloud/ui` today, by habit. LearnHarness enforces its layers with lint.

Two more ideas fit later work: how LearnHarness delivers a background job's result to its conversation exactly once, and how its sub-agents test their output in a headless browser before handing it over.

## Decision

### Tool arguments are repaired before validation

- Every server tool a plugin or the kernel registers ([ADR 0015](0015-plugins.md#server-tools)) gets a `prepareArguments` step in the session host, which Pi runs before it validates.
- A top-level argument that is a string where the schema expects something else (an enum value that isn't this string, a constant, an array, an object, a number, a boolean or null) is parsed as JSON. The parsed value is kept when it fits the schema; otherwise the string stays and validation rejects it as before.
- An enum argument whose value isn't allowed is refused with a message that names the allowed values.
- Arguments that are already right pass through unchanged. Pi's own tools and the user's extensions are left alone.

### Plugins import only the SDK

- Lint lets code under `plugins/` import only `@pi-cloud/plugins`, `@pi-cloud/plugins/web`, `@pi-cloud/protocol` and `@pi-cloud/ui` from Pi Cloud's packages, and no relative path that leaves its own plugin's folder.
- This keeps the built-in plugins honest examples of what a third-party plugin can do ([docs/plugins.md](../plugins.md)).

### Change events instead of polling

- The server serves `GET /api/changes`, a server-sent event stream for signed-in users. Each event names a topic and carries nothing else: `sessions`, `profiles`, `environments`, `plugins` or `mcp-tokens`, or `<plugin>.<name>` for a plugin's own.
- The server publishes a topic after the change is stored. `sessions` is published whenever a Session starts or its view changes, at the same point that tells its watchers. The other kernel topics are published after a write request to their routes succeeds, which covers the web, meta-session tools and MCP alike.
- A plugin's server part publishes its own topics with `ctx.changes.publish(name)`. Its web part names the topics it follows in `useLoaded(load, key, { topics })`, which keeps `everyMs` for data that changes outside Pi Cloud, such as a cluster's state.
- The web keeps one connection per page. A view fetches when it mounts, again when one of its topics arrives (bursts within a quarter of a second become one fetch), and again when the stream reconnects, since events sent while it was away are not replayed.
- The web's lists, Projects and the meta-session list use topics instead of their timers. Polls that follow a running process, such as a subagent's inspect view, stay.
- A topic tells every signed-in user only that something of that kind changed. What changed, and whether they may see it, comes from the normal fetch.

### A context meter in the usage plugin

- The session host publishes a `context` live event with Pi's own context estimate (`getContextUsage`): the tokens in context, or none when Pi can't tell (right after a compaction), and the model's context window. It publishes when the Session starts, when a turn settles, after a compaction and when the model changes.
- The `usage` plugin shows it next to the cost, such as `12k / 200k (6%)`, or `? / 200k` when the tokens aren't known. With no model it shows nothing.

### Later: delivering results exactly once

When automations are built, a run that reports into a Session or Project follows LearnHarness's rules:

- the report gets an id derived from the run, so delivering it twice is a no-op;
- the run counts as done only after its report is stored in the target;
- after a restart, finished runs whose reports aren't stored are delivered again.

The same rules are the checklist for auditing how a Project's threads wake their coordinator ([ADR 0028](0028-projects-around-the-coordinator.md)).

### Later: checking an in-place plugin before it is turned on

A check that loads a built web part in a headless page and reports its errors would catch more than `plugins_build` does ([ADR 0035](0035-meta-sessions.md#in-place-plugins)). It would run the plugin's code before the user turns it on, which ADR 0035 rules out, so it needs a sandbox that can reach nothing first. It stays an open question.

## Consequences

- Smaller models get through tool calls they used to loop on, and a wrong enum tells the model what to send instead.
- A plugin that needs more of Pi Cloud than the SDK offers shows up as a lint error, so the SDK grows instead of being bypassed.
- Lists update as soon as something changes, including changes a meta-session makes, and an idle page stops sending requests every 2 seconds.
- A change made without going through a route, such as a plugin writing to the kernel's tables, publishes no topic. Plugins don't do that.
- The context meter is Pi's estimate, not a count from the provider.
