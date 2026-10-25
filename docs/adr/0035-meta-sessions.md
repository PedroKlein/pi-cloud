# 0035: Meta-sessions

- Status: accepted
- Date: 2026-10-25

## Context

Everything a user does to Pi Cloud itself goes through forms: start a Session, set up a Project, add an Environment, edit a Profile, turn on a plugin. Later plugins, such as workflows, add their own editors. An agent that knows Pi Cloud could do most of this from one request, and could show the result in the UI as it goes.

Several products already let each module give tools to one assistant:

- [Home Assistant's LLM API](https://developers.home-assistant.io/docs/core/llm/): each integration adds tools through a hook. Every tool carries read-only and destructive hints that default to the unsafe value. Each API is also served as MCP at `/api/mcp/<id>` behind an admin token.
- [VS Code language model tools](https://code.visualstudio.com/api/extension-guides/ai/tools) and [Raycast AI Extensions](https://manual.raycast.com/ai/ai-extensions): extensions contribute tools. VS Code always confirms third-party tools. Raycast's default mode runs safe actions and asks for the rest.
- [n8n's AI Workflow Builder](https://docs.n8n.io/advanced-ai/ai-workflow-builder) builds a workflow on the canvas from a prompt, and [Grafana Assistant](https://grafana.com/docs/grafana-cloud/machine-learning/assistant/get-started/) builds dashboards.
- OpenClaw has no admin UI and is [configured by chatting](https://trilogyai.substack.com/p/managing-openclaw-with-claude-code). Its agents edit config files directly, and users report drift, silent defaults and no validation.

The kernel already has most of the pieces. Server tools pick their Sessions with `appliesTo(session)` ([ADR 0015](0015-plugins.md#server-tools)). Plugins can own Sessions ([ADR 0028](0028-projects-around-the-coordinator.md)). Plugin views can be driven by the agent and brought forward with `cloud.reveal` ([ADR 0022](0022-plugin-model-v2.md#views-the-agent-can-use)). Pi 1.3 can also defer tools until a search loads them. It groups tools into namespaces, and it carries read-only and destructive hints that a `tool_call` hook can confirm on (Pi's `docs/extensions.md`, "Tool exposure").

## Decision

### A meta-session is a Session on the meta Profile

- A meta-session is a Session whose job is to change Pi Cloud itself. It is a full Pi Session like any other.
- Every meta-session runs on one built-in, read-only Profile, the meta Profile. Pi Cloud ships its system prompt and skills, and users can't edit it. A user's own Profiles never load in a meta-session, so their extensions, MCP servers and skills stay out of a Session that has admin tools ([ADR 0031](0031-profiles.md) is amended for this). The meta Profile also turns off Pi's `read`, `bash`, `edit` and `write`: a meta-session's workspace is empty, so they could only reach the runner's own machine.
- Provider logins aren't part of a Profile, so a meta-session uses the machine's logins like any Session.
- A user can have any number of meta-sessions. They are separate conversations with the same Profile and tools.
- A `meta` plugin, on by default, owns them, so they stay out of the Session list. It also provides the home screen and the core toolset.

### The home screen

- The home screen is a new meta-session's composer: "What do you want to build today?" Earlier meta-sessions are listed beside it.
- New session stays one click away, for starting a Session without an agent turn.

### Plugins contribute meta toolsets

- A plugin can register a toolset for meta-sessions. A toolset is a Pi namespace with a name, a one-line description and optional longer instructions. Its tools are named `<namespace>_<tool>`, since Pi tool names are global. The kernel registers the Sessions, Environments and Profiles toolsets the same way.
- The plugin that owns meta-sessions says its Sessions load every toolset. Other Sessions load none.
- Server tools gain three fields that the session host passes to Pi: `exposure`, `namespace` and `annotations` (read-only, destructive, idempotent, open world).
- Tools are `deferred` by default, so the agent finds them through Pi's `tool_search` and then calls them directly. Important tools, such as starting and opening a Session, are `direct`. A plugin may mark read-only bulk tools `codemode`. Calls from a codemode script don't appear in the transcript, so they get no tool cards in the chat.
- Each tool is a request to one of Pi Cloud's HTTP routes, made as the user who owns the Session, so validation and defaults are identical to the web UI's. A tool can trim the reply before the model sees it. A meta-session never edits config files or the database directly. (Amended 2026-10-25: tools were first described as calling the routes' domain functions; requests to the routes themselves keep them identical by construction, and MCP serves the same requests.)
- Secret values never go through a tool, since tool calls stay in the transcript and go to the model's provider. A meta-session asks the user to set them on the Environments page, and creating an Environment through a tool doesn't show its runner key.
- Meta toolsets are optional for plugins, like views the agent can use.

### Risky tools ask first

- A meta-session asks the user before a risky call and runs everything else straight away.
- Risky means deleting or archiving something, reading or writing secrets, editing a Profile or Environment, and installing or enabling a plugin. A tool without annotations counts as risky.
- The meta Profile's `tool_call` hook decides from the annotations and raises a confirm card in the chat. It is the same mechanism Pi documents for permission extensions.
- Opening a Session is not risky. Starting a Session or a Project, or creating a Profile, is. The agent they start runs without a confirm of its own, and a Profile's packages run in every Session that uses it. So text injected into a meta-session could otherwise do anything without the user seeing it. (Amended 2026-10-25: this first said starting a Session is not risky.)
- A meta-session acts as the user who owns it and can never do more than that user. Tool handlers already get the caller's actor. When v3 adds roles, a tool can be hidden or refused per user without changing this design.

### Meta-sessions drive the UI

- A tool can send a UI action to the browsers watching its meta-session: open a page, open a plugin's dialog, or open a Session. Like `cloud.reveal`, an action is live and isn't replayed later.
- Opening a Session with an initial prompt sends that prompt right away.
- Plugins register their own actions. For example, the workflows plugin can open its editor on a given workflow.
- On a wide screen the action happens at once. On a phone it shows as a notice with a button, so it doesn't pull the user away from the chat.

### In-place plugins

- A meta-session can write a plugin straight into the installation, the way Pi loads local extensions from its agent folder. It lives in a local plugins folder in the server's data directory, with no repository or release.
- This is a third install source next to git and tarballs ([ADR 0022](0022-plugin-model-v2.md#installing-third-party-plugins) is amended). It shares the plugins folder with them: an in-place plugin is a folder with no `.source.json`, where an installed one records the URL and version it came from.
- The kernel's `plugins` toolset writes it: `plugins_write_file` writes one file, making the plugin when it is new, and `plugins_build` installs its dependencies and bundles its parts to show what is wrong. Neither runs the plugin's code: dependency scripts and Bun macros are off. `plugins_list`, `plugins_files` and `plugins_read_file` read. Writing isn't risky, since nothing written runs until the user turns it on. Building asks, since it reaches the npm registry.
- Only a plugin that is turned off changes, so turning one on trusts the code it has then. A plugin installed from a URL changes only by updating, and one linked into the folder from elsewhere changes there.
- (Amended 2026-10-25: this first said a meta-session that writes a plugin runs on the server's built-in provider with the plugin's folder as its Workspace. The toolset works from any runner, keeps the meta Profile without file tools, and lets the server refuse writes outside the folder, to a plugin that is on, or to one it didn't make.)
- Enabling it is a risky step the user approves, and it restarts the server, like any plugin. A meta-session may write a plugin but never enable one by itself: the toolset has no tool that turns a plugin on, and the build opens the Plugins page for the user.
- Anyone can still build a plugin in its own repository in an ordinary Session or Project and install it from git. In-place plugins are for quick changes to one installation. A user can move one into a repository later.

### MCP

- Pi Cloud serves the same meta toolsets over MCP at `/api/mcp`, so Claude Code or a local Pi can manage Pi Cloud too. It is built together with meta-sessions.
- A client authenticates with a token the user creates for it. Its calls act as that user, with the same tools and the same limits.
- An MCP client has no browser, so UI actions don't apply there. Whether a risky call is confirmed is up to the client. The annotations tell it which calls are risky.
- The endpoint is a path on the same server. It adds no new host or exposure.

### Build order

Meta-sessions are built next, before automations. [ADR 0033](0033-v2-authentication-and-order.md#build-order) gains them as step 5. In-place plugins need third-party install, which isn't built yet, so both come in step 6 (decided 2026-10-25), and automations move to step 7. Automation plugins are then designed with their meta toolsets and UI actions from the start. Projects, Environments and Profiles get the first toolsets.

## Consequences

- The first thing a user sees is an agent turn, not a form. A request costs model tokens, and New session stays for when that isn't wanted.
- The kernel grows three tool fields, UI actions, a read-only built-in Profile, a local plugin source and an MCP endpoint. Each of these is generic.
- Every plugin can be driven from a chat, without an agent ever writing its config by hand.
- A meta-session holds admin tools, so injected text in anything it reads could try to use them. The meta Profile keeps personal extensions out, and risky calls wait for the user. Content a meta-session fetches from outside Pi Cloud is still a risk.
- The meta Profile's prompt and skills ship with Pi Cloud and change with its releases, not with the user.
- In-place plugins make it easy to change an installation without review. They start disabled, the user enables them, and they can be removed like any plugin.
- An MCP token is a new credential that can do whatever its user can, through tools.
