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
```

The first time it starts, the server logs a setup link (`open the setup link to create the first user`). Open it to create your user; the link works once. After that, the page asks for that name and password, and a browser stays signed in for 30 days. Ten wrong passwords for a name lock it for 15 minutes.

On the Environments page, make an Environment named `laptop`. The page shows its key once, in the command that starts an agent:

```sh
PI_CLOUD_KEY=pck_… apps/pi-cloud/dist/pi-cloud agent --name laptop --folder ~/code/my-project
```

Then open New session, pick the `laptop` Environment, enter `~/code/my-project`, and start chatting. A session runs in the Environment it was created in ([ADR 0014](docs/adr/0014-concept-map-and-environments.md)).

The agent only runs sessions in the folders you list with `--folder`, or in folders inside them. One `--folder ~/code` covers every checkout under it, and the form suggests the git checkouts it finds there. By default each session gets its own Git worktree of that folder, on a branch named `pi-cloud/` plus the first 8 characters of the session id, stored under the agent's data directory. Choose "Folder" instead to run in the folder itself; sessions sharing a folder this way can step on each other's changes. "Several repositories" takes clone URLs separated by spaces and checks each one out side by side in one workspace, all on the session's branch: as a worktree of a checkout under a listed folder whose remote is that repository, or as a fresh clone when none is. The Changes panel then shows each repository on its own, and archiving deletes the workspace only if none of them would lose work and no other files sit beside them.

In a session, Enter queues a message for when Pi finishes its turn, and Ctrl+Enter (⌘Enter on a Mac) sends it now, so Pi reads it after its current step. On a phone, Enter starts a new line and the send button sends. A queued message can be taken back or sent now. The header shows the session's token use and cost (the `usage` plugin), and its Diff button opens the Changes panel with what the session changed in its Git workspace (the `changes` plugin). When the agent delegates to subagents (the `subagents` plugin, [ADR 0030](docs/adr/0030-subagents.md)), each run shows as a card in the chat with its agent, progress and time; open it to see the subagent's steps and output. A chip under the composer counts the runs still going. The plugin loads [pi-subagents](https://github.com/nicobailon/pi-subagents) in every session, installing it the first time; if you already use pi-subagents, yours is used instead. Pi shows Pi's own terminal UI for the session, so extensions that only work in a terminal work there too, and Terminal opens a shell in the session's directory. For a worktree or clone, "start from" picks the branch, tag or commit the session's branch starts at.

The home screen asks the Pi Cloud assistant (the `meta` plugin, [ADR 0035](docs/adr/0035-meta-sessions.md)). Type a question and press Enter: that starts a meta-session, a session with no repositories that runs on the plugin's own read-only Profile, without Pi's file and shell tools. Before any tool call that could change something, it shows a card with the tool and its whole input and waits for you to allow it; read-only tools run without asking. A meta-session loads only the `ask`, `models` and `meta` session parts, so subagents and `/pr` aren't there. Its tools manage Sessions, Environments, Profiles and Projects through the same routes as the web UI. They never see secret values, runner keys or what a Profile's MCP servers hold. When it starts or opens something, a wide screen goes there, and a phone shows a notice with an Open button. Earlier conversations are listed under the composer and on the Assistant page, not in the session list. "Start a session yourself" opens the New session form.

The same tools are served over MCP at `/api/mcp`, so Pi or Claude Code on your laptop can manage Pi Cloud too. Make a token under Settings, MCP clients; it is shown once, with the command that adds the server:

```sh
claude mcp add --transport http pi-cloud https://pi-cloud.example/api/mcp --header "Authorization: Bearer pcm_..."
```

A client acts as the user who made its token, and asking before risky tools is up to the client. Revoking the token cuts it off at once. The endpoint answers each request with one JSON reply and opens no event stream.

Projects (the `projects` plugin, [ADR 0016](docs/adr/0016-projects.md)) group work on one goal. Create one on the Projects page with a name, an Environment, its repository URLs and optional instructions. That starts its coordinator, a session with every repository checked out. Tell the coordinator what you want: it starts a thread session for each piece of work, gets a turn with a short notice after each thread turn, and shares Project memory with the threads. The Projects page lists the threads with their run and work state and highlights the ones that need you. You can open any thread and talk to it directly. The Library page (the `library` plugin, [ADR 0018](docs/adr/0018-project-library.md)) holds files shared by a Project: upload them there, and Project sessions get them with `fetch_file` and add their own with `publish_file`.

Fork, in a session's menu, starts a new session that remembers the chat so far, on its own branch from the forked session's branch. `POST /api/sessions/<id>/fork` with an `environment` forks it into another Environment; the new machine gets only what the session pushed.

Archive hides a session from the list and stops it on its machine; its transcript stays readable under "Show archived", and Unarchive picks it up again. Archiving a worktree or clone session also deletes its workspace if Git says nothing would be lost: no uncommitted or untracked files, and every commit pushed. Otherwise the workspace is kept and the session shows "unpushed work" until you delete it yourself; Delete workspace says why it was kept. A clean workspace comes back from its pushed branch when you unarchive. Files listed in a `.worktreeinclude` at the checkout root, such as `.env`, are copied into new worktrees if Git ignores them.

Options:

```text
[PI_CLOUD_SECRET_KEY=<32 bytes, base64>] \
pi-cloud server [--host 127.0.0.1] [--port 7420] [--url <public URL>]
                [--database ~/.pi-cloud/server.db] [--plugins ~/.pi-cloud/plugins]
                [--provider <name> [--data-dir ~/.pi-cloud/server]
                [--folder <path>]... [--extension <path>]...]
PI_CLOUD_KEY=<Environment key> | PI_CLOUD_TOKEN=<runner token> \
pi-cloud agent --name <runner> [--capacity <n>] [--exit-when-idle <seconds>]
               [--server http://127.0.0.1:7420] [--data-dir ~/.pi-cloud/agent]
               [--session-binary <path>] [--folder <path>]...
               [--extension <path>]...
```

`--host` is the address the server listens on; use `0.0.0.0` behind a proxy or in a container. `--url` is where people open it, when that differs, so the setup link points there. `--provider` also runs an agent inside the server, in the Environment of that name, which needs no key.

`--plugins` is the folder for installed plugins, next to the database by default ([ADR 0022](docs/adr/0022-plugin-model-v2.md#installing-third-party-plugins)). Each plugin is a folder named by its id, holding a `package.json` with a `piCloud` field: `id`, `title`, `description`, `engine` (1), `capabilities`, and `parts.server`, `parts.web` and `parts.session`. A web part's default export is the same `WebPlugin` object a built-in exports, and it shares the page's `react`, `react-dom`, `@pi-cloud/ui` and `@pi-cloud/plugins/web`. It can't import CSS or other files yet, and the page's Tailwind classes cover only what the app itself uses, so style it with `@pi-cloud/ui` components. A Session part's default export is a `SessionPlugin`, like a built-in's. Set `piCloud.ownSessionsOnly` to load it only in the Sessions its server part owns. Each runner fetches it by its hash into the Session's folder when the Session starts, and a runner too old to know installed parts won't start the Session. Install one on the Plugins page from a git repository, at the branch, tag or commit after `#` or its default branch, or from a `.tgz` holding one folder, by an https, ssh or file URL. The server needs `git` or `tar` for that. A URL can't hold credentials, since everyone sees it, so reach a private repository over ssh with a key; a fetched plugin can't hold links, and a tarball is at most 100 MB. It pins the commit or the tarball's SHA-256 in `.source.json` in the plugin's folder, and Update fetches the newest version from the same URL for the next start. When that version asks for capabilities the old one didn't, or adds a web or Session part, it is turned off until you turn it on again. Until the restart, the running version keeps its settings. Remove works once the plugin isn't running. An installed plugin starts turned off and none of its code runs, and turning it on asks first, listing what it asks for and where its parts run. When it is on, the server installs its `dependencies` and bundles its parts into `.build` in its folder each time it starts, using its own binary as `bun`, so the machine needs neither Bun nor npm. It installs without running the plugin's scripts, and gives up after two minutes. A build error shows on the Plugins page. Bundled code runs from `.build`, so a part that reads files next to itself through `import.meta.url` should look one folder up. Turn it on on the Plugins page; that takes effect when the server next starts, and `enabled.json` in the folder lists the ones turned on. Restart now on that page makes the server exit with code 75 for whatever runs it to start it again: systemd with `Restart=on-failure`, a pod, or `bun run dev`. It asks first while a Session on the server's own runner is mid-turn, since that turn is interrupted. The server knows systemd by `INVOCATION_ID`; the chart and the dev loop set `PI_CLOUD_SUPERVISED=1`, which you can set for any other supervisor that restarts on exit. Elsewhere it says to restart the server yourself. Its server part only gets the parts of the plugin context its `capabilities` name: `tools`, `toolsets`, `events`, `sessions`, `environments`, `profiles`, `routes` and `models`.

An agent joins the pool of the Environment whose key it holds, under its `--name`, and gets a token of its own for everything else ([ADR 0033](docs/adr/0033-v2-authentication-and-order.md)). Each session it starts gets a token too, which reaches only that session. Replace key on the Environments page lets go of every agent that joined with the old key; start them again with the new one. The agent reads the key from `PI_CLOUD_KEY` and removes it from what its sessions inherit. A runner that a plugin starts, such as a Kubernetes pod, gets a token in `PI_CLOUD_TOKEN` instead, and `--exit-when-idle <seconds>` stops it once it has run no session for that long. Tests of the built binary set `PI_CLOUD_FAUX_REPLY` so every turn answers with that text and no model provider is needed.

An Environment can have a setup script, variables and secrets (`PATCH /api/environments/<id>` with `setupScript`, `variables` and `secrets`; a null secret removes it). Each agent runs the setup script once per version before the first session that needs it, and a session's processes and terminals get the variables and secrets. The API lists secret names only. The server encrypts secrets with AES-GCM before it stores them, using the key in `PI_CLOUD_SECRET_KEY` (`openssl rand -base64 32`), or else one it makes in `server.db.key` next to the database. Losing the key loses every stored secret. A `GH_TOKEN` secret also signs git in to GitHub over https, both for cloning a session's repositories and for the session's own pushes.

With `isolation: "container"`, each session's Pi process runs in a container from the Environment's `image` (default `node:22-bookworm`; any image with glibc, bash and git works), as the agent's user, with the agent's data directory, its `--folder`s and the workspace mounted at the same paths. The agent needs Docker. It mounts its own Linux binary into the container, so a Linux agent built with `bun run build` needs nothing else, and an agent on a Mac or run from source needs `--session-binary <path to a Linux pi-cloud binary>`. The setup script then runs once in the image as root, and sessions run in the image it leaves. Terminals open a shell in the session's container.

Several agents can join one Environment's pool with its key ([ADR 0032](docs/adr/0032-environments-and-runners.md)). `--capacity` caps how many sessions the agent runs at once. A session in a folder goes to an agent that lists the folder, and a session that has run goes back to the agent it ran on. A clone or several-repositories session moves to another agent in the pool if its agent stops polling for a minute; it starts again from its transcript in a fresh checkout of its branch, so only pushed work comes along. An agent that can't reach the server for 30 seconds stops those sessions itself, so two agents never run one session.

### In Kubernetes

The `Dockerfile` builds an image that runs the server, and `deploy/helm/pi-cloud` installs it with one replica and its data on a ReadWriteOnce volume ([ADR 0034](docs/adr/0034-v2-deployment-and-credentials.md)). On install the chart makes a Secret holding the secret key, and it keeps that Secret on upgrades and uninstalls. Put HTTPS in front with your gateway, and set `url` to where people open it:

```sh
helm install pi-cloud deploy/helm/pi-cloud --set url=https://pi.example.com
kubectl logs deploy/pi-cloud | grep setup
```

On Kyma, `apiRule.enabled` puts the server behind Kyma's gateway at `apiRule.host`, and `url` defaults to that host:

```sh
helm install pi-cloud deploy/helm/pi-cloud --namespace pi-cloud --create-namespace \
  --set apiRule.enabled=true --set apiRule.host=pi-cloud.<cluster domain>
```

Every push to main publishes the image as `ghcr.io/pedroklein/pi-cloud:main` and `:sha-<commit>`. Agents on other machines join it with an Environment's key, as above. `builtInRunner` also runs a runner inside the server pod.

The kubernetes plugin can start runner pods for an Environment in the server's namespace ([ADR 0032](docs/adr/0032-environments-and-runners.md)). The chart gives the server a service account that may create and delete pods and Secrets there; set `runnerPods.enabled=false` to leave that out. To make an Environment use pods, turn on runner pods in its Kubernetes section on the Environments page, or save its settings:

```sh
curl <server>/api/plugins/kubernetes/environments/<environment id> \
  -H 'content-type: application/json' --cookie <session cookie> \
  -d '{"settings": {"workspace": "pod", "capacity": 1, "maxPods": 5, "idleSeconds": 300, "podPatch": {}}}'
```

`{"settings": null}` turns them off again.

When some of its Sessions can't go to any runner, the plugin starts one pod for each `capacity` of them, up to `maxPods`. A pod runs the Environment's image, or the Pi Cloud image when it names none, with the `pi-cloud` binary copied in. Its agent stops after `idleSeconds` without a Session, and the plugin then deletes the pod and its token. A pod that hasn't started after 10 minutes is deleted too. When a pod fails, or stops without its agent ever reaching the server, the next pod for that Environment waits 10 seconds, twice as long after each failure in a row up to about 5 minutes, and the Environment's Kubernetes section shows why. `podPatch` is a JSON merge patch on the pod, such as `{"spec": {"nodeSelector": {"pool": "agents"}}}`; it can't give the pod a service account token. Pods run Sessions as processes, so the Environment's isolation must be `process`. With `"workspace": "pod"`, the default, a workspace lives only as long as its pod, so use clone or repositories workspaces there. With `"workspace": "claim"`, each Session gets a pod of its own, named after it, whose home is a claim of `claimSize` (with `storageClass`, or the cluster's default). If that pod stops or is deleted, the plugin starts it again with the same claim, and the claim goes once the Session is archived.

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

Tests use Pi's faux model provider, so they need no API key. `bun test ./apps/pi-cloud/src/kind.e2e.ts` runs against the chart installed in your current kubectl context, as CI does on kind. `bun run test:e2e` drives the web UI in headless Chromium against a server with a faux-model provider. It needs Playwright's browser once: `bun x playwright-core install chromium`. [AGENTS.md](AGENTS.md) has the coding conventions.

`bun run smoke` checks that Pi Cloud works with your own Pi setup: your default model, your extensions and your shell. It starts a server and an agent, creates a session in a temporary directory, sends one short prompt to your default model, runs a command in the terminal, and fails if the agent printed any errors. The prompt costs a few tokens. Pass `--model provider/id` to use a cheaper model than your default, as in `bun run smoke --model openai/gpt-5-mini`.
