# Pi Cloud

Pi Cloud runs [Pi](https://github.com/earendil-works/pi) coding-agent sessions on your own machines and lets you reach them from a browser. A session keeps running when you close the tab, and you can pick it up later from another device with the full transcript and a live terminal.

It's self-hosted and meant for one person. The plan is a small server on an always-on VM plus an agent on your laptop, so a session can run wherever the work needs it.

> **Status: early.** Sessions run end to end on a local agent, or on the server's own provider in a fresh clone, with a minimal web UI. There's no authentication yet, so only run it on localhost or behind an SSH tunnel. Expect breaking changes.

## How it works

```text
browser ──HTTP/SSE──▶ pi-cloud server ◀──long-poll + HTTPS/SSE── pi-cloud agent ──▶ Pi sessions
                      (web UI, SQLite)                          (your laptop)
```

- `pi-cloud server` serves the web UI, stores sessions and a copy of each transcript in SQLite, and relays commands.
- `pi-cloud agent` connects out to the server, so the laptop needs no open port. It runs each Pi session in its own process, in a working directory you choose, with the Pi setup of the Profile it picked: packages, instructions and settings. Each machine keeps its own model logins in its data directory, so log it in once with `/login` from any session. A session that crashes reloads from its transcript without touching the others.
- `pi-cloud server --provider <name>` also runs an agent inside the server. On a VM, its sessions each clone a repository and work on their own branch. See [docs/vm.md](docs/vm.md).
- If the laptop sleeps or goes offline, its sessions keep running and catch up when it reconnects.

The design is written down in [docs/architecture.md](docs/architecture.md) and the decision records in [docs/adr/](docs/adr/).

## Run it

You need [Bun](https://bun.sh) and a working Pi setup with at least one model you can log in to.

```sh
bun install
bun run build
apps/pi-cloud/dist/pi-cloud server
apps/pi-cloud/dist/pi-cloud agent --name laptop --folder ~/code/my-project
```

Open http://127.0.0.1:7420, pick the `laptop` Environment, enter `~/code/my-project`, and start chatting. Each provider gets an Environment of the same name the first time it connects, and a session runs in the Environment it was created in ([ADR 0014](docs/adr/0014-concept-map-and-environments.md)).

The agent only runs sessions in the folders you list with `--folder`, or in folders inside them. One `--folder ~/code` covers every checkout under it, and the form suggests the git checkouts it finds there. By default each session gets its own Git worktree of that folder, on a branch named `pi-cloud/` plus the first 8 characters of the session id, stored under the agent's data directory. Choose "Folder" instead to run in the folder itself; sessions sharing a folder this way can step on each other's changes. "Several repositories" takes clone URLs separated by spaces and checks each one out side by side in one workspace, all on the session's branch: as a worktree of a checkout under a listed folder whose remote is that repository, or as a fresh clone when none is. The Changes panel then shows each repository on its own, and archiving deletes the workspace only if none of them would lose work and no other files sit beside them.

In a session, Enter queues a message for when Pi finishes its turn, and Ctrl+Enter (⌘Enter on a Mac) sends it now, so Pi reads it after its current step. On a phone, Enter starts a new line and the send button sends. A queued message can be taken back or sent now. The header shows the session's token use and cost (the `usage` plugin), and its Diff button opens the Changes panel with what the session changed in its Git workspace (the `changes` plugin). When the agent delegates to subagents (the `subagents` plugin, [ADR 0030](docs/adr/0030-subagents.md)), each run shows as a card in the chat with its agent, progress and time; open it to see the subagent's steps and output. A chip under the composer counts the runs still going. The plugin loads [pi-subagents](https://github.com/nicobailon/pi-subagents) in every session, installing it the first time; if you already use pi-subagents, yours is used instead. Pi shows Pi's own terminal UI for the session, so extensions that only work in a terminal work there too, and Terminal opens a shell in the session's directory. For a worktree or clone, "start from" picks the branch, tag or commit the session's branch starts at.

Projects (the `projects` plugin, [ADR 0016](docs/adr/0016-projects.md)) group work on one goal. Create one on the Projects page with a name, an Environment, its repository URLs and optional instructions. That starts its coordinator, a session with every repository checked out. Tell the coordinator what you want: it starts a thread session for each piece of work, gets a turn with a short notice after each thread turn, and shares Project memory with the threads. The Projects page lists the threads with their run and work state and highlights the ones that need you. You can open any thread and talk to it directly. The Library page (the `library` plugin, [ADR 0018](docs/adr/0018-project-library.md)) holds files shared by a Project: upload them there, and Project sessions get them with `fetch_file` and add their own with `publish_file`.

Fork, in a session's menu, starts a new session that remembers the chat so far, on its own branch from the forked session's branch. `POST /api/sessions/<id>/fork` with an `environment` forks it into another Environment; the new machine gets only what the session pushed.

Archive hides a session from the list and stops it on its machine; its transcript stays readable under "Show archived", and Unarchive picks it up again. Archiving a worktree or clone session also deletes its workspace if Git says nothing would be lost: no uncommitted or untracked files, and every commit pushed. Otherwise the workspace is kept and the session shows "unpushed work" until you delete it yourself; Delete workspace says why it was kept. A clean workspace comes back from its pushed branch when you unarchive. Files listed in a `.worktreeinclude` at the checkout root, such as `.env`, are copied into new worktrees if Git ignores them.

Options:

```text
pi-cloud server [--port 7420] [--database ~/.pi-cloud/server.db]
                [--provider <name> [--data-dir ~/.pi-cloud/server]
                [--folder <path>]... [--extension <path>]...]
pi-cloud agent --name <runner> [--environment <name>] [--capacity <n>]
               [--server http://127.0.0.1:7420] [--data-dir ~/.pi-cloud/agent]
               [--session-binary <path>] [--folder <path>]...
               [--extension <path>]...
```

An Environment can have a setup script, variables and secrets (`PATCH /api/environments/<id>` with `setupScript`, `variables` and `secrets`; a null secret removes it). Each agent runs the setup script once per version before the first session that needs it, and a session's processes and terminals get the variables and secrets. The API lists secret names only. A `GH_TOKEN` secret also signs git in to GitHub over https, both for cloning a session's repositories and for the session's own pushes.

With `isolation: "container"`, each session's Pi process runs in a container from the Environment's `image` (default `node:22-bookworm`; any image with glibc, bash and git works), as the agent's user, with the agent's data directory, its `--folder`s and the workspace mounted at the same paths. The agent needs Docker. It mounts its own Linux binary into the container, so a Linux agent built with `bun run build` needs nothing else, and an agent on a Mac or run from source needs `--session-binary <path to a Linux pi-cloud binary>`. The setup script then runs once in the image as root, and sessions run in the image it leaves. Terminals open a shell in the session's container.

Several agents can join one Environment's pool with `--environment <name>` ([ADR 0032](docs/adr/0032-environments-and-runners.md)); without it an agent joins the Environment named after it. `--capacity` caps how many sessions the agent runs at once. A session in a folder goes to an agent that lists the folder, and a session that has run goes back to the agent it ran on. A clone or several-repositories session moves to another agent in the pool if its agent stops polling for a minute; it starts again from its transcript in a fresh checkout of its branch, so only pushed work comes along. An agent that can't reach the server for 30 seconds stops those sessions itself, so two agents never run one session.

## Roadmap

- **v1:** independent sessions and Projects (a coordinator session plus thread sessions) on a laptop and one VM.
- **v2:** Kubernetes, stronger isolation between sessions, and a public extension interface.

See [docs/vision.md](docs/vision.md) for scope and non-goals, and [docs/open-questions.md](docs/open-questions.md) for what isn't decided yet.

## Repository layout

```text
apps/pi-cloud     the pi-cloud binary: server and agent
apps/web          the web UI
packages/         protocol, sessions, providers, workspaces and the session host
docs/             vision, architecture, research and decision records
```

## Development

`bun run dev` runs the server with a built-in provider named `cloud`, plus an agent named `local` that may use this repository's folder, from source, and restarts both when a file under `apps/` or `packages/` changes. Its data lives in `~/.pi-cloud/dev`.

```sh
bun run dev
bun run format
bun run lint
bun run typecheck
bun test
```

Tests use Pi's faux model provider, so they need no API key. `bun run test:e2e` drives the web UI in headless Chromium against a server with a faux-model provider. It needs Playwright's browser once: `bun x playwright-core install chromium`. [AGENTS.md](AGENTS.md) has the coding conventions.

`bun run smoke` checks that Pi Cloud works with your own Pi setup: your default model, your extensions and your shell. It starts a server and an agent, creates a session in a temporary directory, sends one short prompt to your default model, runs a command in the terminal, and fails if the agent printed any errors. The prompt costs a few tokens. Pass `--model provider/id` to use a cheaper model than your default, as in `bun run smoke --model openai/gpt-5-mini`.
