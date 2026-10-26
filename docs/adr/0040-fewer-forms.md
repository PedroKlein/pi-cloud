# 0040: Fewer Forms

- Status: accepted
- Date: 2026-10-26

## Context

Pi Cloud asks for too much to get started. On main at `7abfc83`, with an empty database:

- New session is a dialog with eight fields: the first message, an Environment, a workspace kind, a start point, a path typed by hand, a model typed as `provider/id`, a reasoning level and a Profile.
- New Project is a form with seven fields: name, Environment, Profile, two models typed by hand, repository URLs one per line, and instructions.
- Profiles, Environments, Plugins, Settings and Models are five sidebar entries above the Sessions, and every plugin page is pinned there too.
- Getting a laptop ready takes four pages: name an Environment, make a key, copy a command that leaves out `--folder`, run it, and come back with no sign that it worked. Nothing says that no model is logged in.
- Inputs are native selects, a datalist with every model, and textareas parsed one line at a time.

Claude Code does more and asks for less. Its new-session composer has repository, branch, environment and model chips under the prompt, remembered from last time ([Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)). Its desktop app picks a folder from a recent list and makes a worktree by default. Settings is one screen with sections, opened from the account menu, and the sidebar holds the work. A Project starts with a name, its repositories and a goal.

## Decision

### Starting a Session

- The home screen stays the assistant ([ADR 0035](0035-meta-sessions.md)). New session opens a composer in place of the dialog: the prompt, then chips for where, start point, Environment and model with reasoning. Enter starts the Session.
- The where chip is a searchable picker of recent folders and repositories, the checkouts the Environment's machines list, and a pasted repository URL. The workspace kind follows from the pick: a folder gets a worktree, a URL gets a clone, and two or more picks make a several-repositories workspace. "Share the folder" is a toggle inside the picker for a folder workspace.
- The Environment chip and a Profile chip show only when there is more than one to choose from. Every chip starts from the choice made last time in this browser.
- The model chip is the same picker the Session header uses, with reasoning in it. No model is typed by hand.

### Settings

- Profiles, Environments, Models, Plugins, MCP clients and sign-in become sections of one Settings page, opened from the account menu at the bottom of the sidebar. A plugin's installation settings ([ADR 0036](0036-plugin-settings.md)) get a section of their own. A plugin's Environment settings stay in that Environment's section.
- Each section keeps one Save button.
- The sidebar keeps New session, search, Projects and the Sessions. Plugin pages show there only when pinned; the rest are under "More", where each has a pin. Pins are saved per user on the server, so they follow the user to other devices. Projects and the assistant start pinned, and a newly installed plugin starts under More.

### Inputs

- One picker (searchable popover, recent first) replaces native selects and the model datalist.
- A list input (add and remove chips) replaces "one per line" textareas for packages, repositories and folders.
- A key and value table replaces the variables and secrets textareas. A lock on a row makes it a secret, and pasting a `.env` fills the rows.
- Multi-line text such as setup scripts and AGENTS.md stays a text editor. Raw JSON, such as a Profile's Pi settings and MCP servers, stays behind "Edit as file".
- Rarely changed Environment fields (isolation, image, Kubernetes pods) fold under Advanced.

### Starting a Project

- New Project asks for a name, its repositories (the same picker as a Session) and a goal. The goal is stored on the Project as its topic and added to the context of the coordinator and every thread, like a Claude Code Project's topic. It is not sent as a message; the coordinator waits until the user writes.
- Environment, models, Profile and instructions take their defaults and are changed behind the Project's gear.

### First run

- Until it is done, the home screen shows a checklist: connect a machine, and log in to a model provider.
- Connect a machine shows one command with a key in it. The first key makes an Environment named after the machine when it joins, so nobody names an Environment before they know what one is. The step turns done when the machine connects.
- Log in to a model starts a Session that runs `/login` ([ADR 0024](0024-provider-login-from-the-web.md)).
- `pi-cloud agent` defaults `--name` to the hostname and `--folder` to the folder it starts in.

## Consequences

- New session goes from eight fields to a prompt and chips that are usually right already. New Project goes from seven fields to three.
- The sidebar shows work. Configuration is one click further away, behind the account menu, like Claude Code.
- The `nav.Items` and `Page` plugin slots stay, and a page is reached through More when it isn't pinned. Plugins need no change.
- Per-user pins need a small per-user preferences store in the kernel.
- The Projects plugin gains a goal field next to its instructions.
- The build goes in small PRs: inputs, New session, Settings and sidebar, Projects, first run.
