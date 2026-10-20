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
- `pi-cloud agent` connects out to the server, so the laptop needs no open port. It runs each Pi session in a working directory you choose, using your own Pi setup: models, logins and extensions.
- `pi-cloud server --provider <name>` also runs an agent inside the server. On a VM, its sessions each clone a repository and work on their own branch. See [docs/vm.md](docs/vm.md).
- If the laptop sleeps or goes offline, its sessions keep running and catch up when it reconnects.

The design is written down in [docs/architecture.md](docs/architecture.md) and the decision records in [docs/adr/](docs/adr/).

## Run it

You need [Bun](https://bun.sh) and a working Pi setup with at least one model you can log in to.

```sh
bun install
bun run build
apps/pi-cloud/dist/pi-cloud server
apps/pi-cloud/dist/pi-cloud agent --name laptop
```

Open http://127.0.0.1:7420, create a session for provider `laptop` with a directory on this machine, and start chatting.

Options:

```text
pi-cloud server [--port 7420] [--database ~/.pi-cloud/server.db]
                [--provider <name> [--data-dir ~/.pi-cloud/server]
                [--extension <path>]...]
pi-cloud agent --name <provider> [--server http://127.0.0.1:7420]
               [--data-dir ~/.pi-cloud/agent] [--extension <path>]...
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

`bun run dev` runs the server with a built-in provider named `cloud`, plus an agent named `local`, from source, and restarts both when a file under `apps/` or `packages/` changes. Its data lives in `~/.pi-cloud/dev`.

```sh
bun run dev
bun run format
bun run lint
bun run typecheck
bun test
```

Tests use Pi's faux model provider, so they need no API key. [AGENTS.md](AGENTS.md) has the coding conventions.

`bun run smoke` checks that Pi Cloud works with your own Pi setup: your default model, your extensions and your shell. It starts a server and an agent, creates a session in a temporary directory, sends one short prompt to your default model, runs a command in the terminal, and fails if the agent printed any errors. The prompt costs a few tokens.
