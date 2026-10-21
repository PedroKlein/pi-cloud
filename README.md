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
- `pi-cloud agent` connects out to the server, so the laptop needs no open port. It runs each Pi session in its own process, in a working directory you choose, using your own Pi setup: models, logins and extensions. A session that crashes reloads from its transcript without touching the others.
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

The agent only runs sessions in the folders you list with `--folder`. By default each session gets its own Git worktree of that folder, on a branch named `pi-cloud/` plus the first 8 characters of the session id, stored under the agent's data directory. Choose "Folder" instead to run in the folder itself; sessions sharing a folder this way can step on each other's changes.

In a session, Enter sends a message that steers the running turn, and Alt+Enter (Option+Enter on a Mac) queues it as a follow-up for after the turn. The header shows the session's token use and cost, the Changes panel shows what the session changed in its Git workspace, and Terminal opens a shell in the session's directory. For a worktree or clone, "start from" picks the branch, tag or commit the session's branch starts at.

Archive hides a session from the list and stops it on its machine; its transcript stays readable under "Show archived", and Unarchive picks it up again. Archiving a worktree or clone session also deletes its workspace if Git says nothing would be lost: no uncommitted or untracked files, and every commit pushed. Otherwise the workspace is kept and the session shows "unpushed work" until you delete it yourself. A clean workspace comes back from its pushed branch when you unarchive. Files listed in a `.worktreeinclude` at the checkout root, such as `.env`, are copied into new worktrees if Git ignores them.

Options:

```text
pi-cloud server [--port 7420] [--database ~/.pi-cloud/server.db]
                [--provider <name> [--data-dir ~/.pi-cloud/server]
                [--folder <path>]... [--extension <path>]...]
pi-cloud agent --name <provider> [--server http://127.0.0.1:7420]
               [--data-dir ~/.pi-cloud/agent] [--folder <path>]...
               [--extension <path>]...
```

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
