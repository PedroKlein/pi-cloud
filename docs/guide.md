# Pipoca guide

How to run Pipoca and what each part of it does, in more detail than the [README](../README.md). The design behind it is in [architecture.md](architecture.md) and the decision records in [adr/](adr/).

## Run it on your laptop

You need [Bun](https://bun.sh) and a working Pi setup with at least one model you can log in to.

```sh
bun install
bun run build
apps/pipoca/dist/pipoca server
```

The first time it starts, the server logs a setup link (`open the setup link to create the first user`). Open it to create your user; the link works once. After that, the page asks for that name and password, and a browser stays signed in for 30 days. Ten wrong passwords for a name lock it for 15 minutes.

On the Environments page, make an Environment named `laptop`. The page shows its key once, in the command that starts an agent:

```sh
PIPOCA_KEY=pck_… apps/pipoca/dist/pipoca agent --name laptop --folder ~/code/my-project
```

Then open New session, type what Pi should do, pick `~/code/my-project` in the folder chip (and the `laptop` Environment, when there is more than one), and press Enter. The composer remembers what you picked for next time. A session runs in the Environment it was created in ([ADR 0014](adr/0014-concept-map-and-environments.md)).

The agent only runs sessions in the folders you list with `--folder`, or in folders inside them. One `--folder ~/code` covers every checkout under it, and the folder chip lists the git checkouts it finds there, after the ones you used recently. The workspace follows from what you pick ([ADR 0040](adr/0040-fewer-forms.md)). A folder gets its own Git worktree, on a branch named `pipoca/` plus the first 8 characters of the session id, stored under the agent's data directory. Tick "Share the folder" in the chip to run in the folder itself; sessions sharing a folder this way can step on each other's changes. A pasted repository URL gets a fresh clone. Two or more URLs check each one out side by side in one workspace, all on the session's branch: as a worktree of a checkout under a listed folder whose remote is that repository, or as a fresh clone when none is. The Changes panel then shows each repository on its own, and archiving deletes the workspace only if none of them would lose work and no other files sit beside them.

### In a session

In a session, Enter queues a message for when Pi finishes its turn, and Ctrl+Enter (⌘Enter on a Mac) sends it now, so Pi reads it after its current step. On a phone, Enter starts a new line and the send button sends. A queued message can be taken back or sent now. The header shows the session's token use and cost (the `usage` plugin), and its Diff button opens the Changes panel with what the session changed in its Git workspace (the `changes` plugin). When the agent delegates to subagents (the `subagents` plugin, [ADR 0030](adr/0030-subagents.md)), each run shows as a card in the chat with its agent, progress and time; open it to see the subagent's steps and output. A chip under the composer counts the runs still going. The plugin loads [pi-subagents](https://github.com/nicobailon/pi-subagents) in every session, installing it the first time; if you already use pi-subagents, yours is used instead. Pi shows Pi's own terminal UI for the session, so extensions that only work in a terminal work there too, and Terminal opens a shell in the session's directory. For a worktree or clone, the "from" chip picks the branch, tag or commit the session's branch starts at.

### The assistant

The home screen asks the Pipoca assistant (the `meta` plugin, [ADR 0035](adr/0035-meta-sessions.md)). Type a question and press Enter: that starts a meta-session, a session with no repositories that runs on the plugin's own read-only Profile, without Pi's file and shell tools. Before any tool call that could change something, it shows a card with the tool and its whole input and waits for you to allow it; read-only tools run without asking. A meta-session loads only the `ask`, `models` and `meta` session parts, so subagents and `/pr` aren't there. Its tools manage Sessions, Environments, Profiles and Projects through the same routes as the web UI. It can also write an in-place plugin into the plugins folder and build it, without running any of its code; turning it on stays yours, on the Plugins page. They never see secret values, runner keys or what a Profile's MCP servers hold. When it starts or opens something, a wide screen goes there, and a phone shows a notice with an Open button. Earlier conversations are listed under the composer and on the Assistant page, not in the session list. "Start a session yourself" opens the New session form.

### MCP clients

The same tools are served over MCP at `/api/mcp`, so Pi or Claude Code on your laptop can manage Pipoca too. Make a token under Settings, MCP clients; it is shown once, with the command that adds the server:

```sh
claude mcp add --transport http pipoca https://pipoca.example/api/mcp --header "Authorization: Bearer pcm_..."
```

A client acts as the user who made its token, and asking before risky tools is up to the client. Revoking the token cuts it off at once. The endpoint answers each request with one JSON reply and opens no event stream.

### Projects and the library

Projects (the `projects` plugin, [ADR 0016](adr/0016-projects.md)) group work on one goal. Create one on the Projects page with a name, an Environment, its repository URLs and optional instructions. That starts its coordinator, a session with every repository checked out. Tell the coordinator what you want: it starts a thread session for each piece of work, gets a turn with a short notice after each thread turn, and shares Project memory with the threads. The Projects page lists the threads with their run and work state and highlights the ones that need you. You can open any thread and talk to it directly. The Library page (the `library` plugin, [ADR 0018](adr/0018-project-library.md)) holds files shared by a Project: upload them there, and Project sessions get them with `fetch_file` and add their own with `publish_file`.

### Fork and archive

Fork, in a session's menu, starts a new session that remembers the chat so far, on its own branch from the forked session's branch. `POST /api/sessions/<id>/fork` with an `environment` forks it into another Environment; the new machine gets only what the session pushed.

Archive hides a session from the list and stops it on its machine; its transcript stays readable under "Show archived", and Unarchive picks it up again. Archiving a worktree or clone session also deletes its workspace if Git says nothing would be lost: no uncommitted or untracked files, and every commit pushed. Otherwise the workspace is kept and the session shows "unpushed work" until you delete it yourself; Delete workspace says why it was kept. A clean workspace comes back from its pushed branch when you unarchive. Files listed in a `.worktreeinclude` at the checkout root, such as `.env`, are copied into new worktrees if Git ignores them.

### Server and agent options

Options:

```text
[PIPOCA_SECRET_KEY=<32 bytes, base64>] \
pipoca server [--host 127.0.0.1] [--port 7420] [--url <public URL>]
                [--database ~/.pipoca/server.db] [--plugins ~/.pipoca/plugins]
                [--provider <name> [--data-dir ~/.pipoca/server]
                [--folder <path>]... [--extension <path>]...]
PIPOCA_KEY=<Environment key> | PIPOCA_TOKEN=<runner token> \
pipoca agent --name <runner> [--capacity <n>] [--exit-when-idle <seconds>]
               [--server http://127.0.0.1:7420] [--data-dir ~/.pipoca/agent]
               [--session-binary <path>] [--folder <path>]...
               [--extension <path>]...
```

`--host` is the address the server listens on; use `0.0.0.0` behind a proxy or in a container. `--url` is where people open it, when that differs, so the setup link points there. `--provider` also runs an agent inside the server, in the Environment of that name, which needs no key.

### Plugins

`--plugins` is the folder for installed plugins, next to the database by default ([ADR 0022](adr/0022-plugin-model-v2.md#installing-third-party-plugins)). [docs/plugins.md](plugins.md) shows how to write one. Each is a folder named by its id with a `pipoca` manifest in its `package.json`. Install one on the Plugins page from a git repository or a `.tgz` URL, pinned to its commit or SHA-256 in `.source.json` in its folder, or let the assistant write one in place. Update fetches the newest version from the same URL, and Remove works once the plugin isn't running. An installed plugin starts turned off and none of its code runs. Turning it on asks first, listing the capabilities it asks for and where its parts run, and takes effect when the server next starts; `enabled.json` in the folder lists the ones turned on. A plugin that is on is installed and bundled into `.build` each time the server starts, using the server's own binary as `bun`, so the machine needs neither Bun nor npm, and a build error shows on the Plugins page. Restart now on that page makes the server exit with code 75 for whatever runs it to start it again: systemd with `Restart=on-failure`, a pod, or `bun run dev`. It asks first while a Session on the server's own runner is mid-turn, since that turn is interrupted. The server knows systemd by `INVOCATION_ID`; the chart and the dev loop set `PIPOCA_SUPERVISED=1`, which you can set for any other supervisor that restarts on exit. Elsewhere it says to restart the server yourself.

### Keys and tokens

An agent joins the pool of the Environment whose key it holds, under its `--name`, and gets a token of its own for everything else ([ADR 0033](adr/0033-v2-authentication-and-order.md)). Each session it starts gets a token too, which reaches only that session. Replace key on the Environments page lets go of every agent that joined with the old key; start them again with the new one. The agent reads the key from `PIPOCA_KEY` and removes it from what its sessions inherit. A runner that a plugin starts, such as a Kubernetes pod, gets a token in `PIPOCA_TOKEN` instead, and `--exit-when-idle <seconds>` stops it once it has run no session for that long. Tests of the built binary set `PIPOCA_FAUX_REPLY` so every turn answers with that text and no model provider is needed.

### Environment setup and secrets

An Environment can have a setup script, variables and secrets (`PATCH /api/environments/<id>` with `setupScript`, `variables` and `secrets`; a null secret removes it). Each agent runs the setup script once per version before the first session that needs it, and a session's processes and terminals get the variables and secrets. The API lists secret names only. The server encrypts secrets with AES-GCM before it stores them, using the key in `PIPOCA_SECRET_KEY` (`openssl rand -base64 32`), or else one it makes in `server.db.key` next to the database. Losing the key loses every stored secret. A `GH_TOKEN` secret also signs git in to GitHub over https, both for cloning a session's repositories and for the session's own pushes.

Model provider and MCP server logins belong to each person and live on the server, sealed with the same key ([ADR 0045](adr/0045-server-kept-logins.md)). `/login` and `/mcp login` in any Session save the login there, and every Session that person starts uses it, on any runner, so a Kubernetes pod that exits keeps nothing. Runners read and write a login through the server, which lets one runner at a time refresh it, since providers rotate refresh tokens. An MCP sign-in opens on your device; when the server sends you back to an address on the runner, paste the address your browser lands on. Settings lists your logins under Logins, where you can log out of one. With the `logins` plugin off, each runner keeps its own logins in its data folder as before.

### Containers

With `isolation: "container"`, each session's Pi process runs in a container from the Environment's `image` (default `node:22-bookworm`; any image with glibc, bash and git works), as the agent's user, with the agent's data directory, its `--folder`s and the workspace mounted at the same paths. The agent needs Docker. It mounts its own Linux binary into the container, so a Linux agent built with `bun run build` needs nothing else, and an agent on a Mac or run from source needs `--session-binary <path to a Linux pipoca binary>`. The setup script then runs once in the image as root, and sessions run in the image it leaves. Terminals open a shell in the session's container.

### Runner pools

Several agents can join one Environment's pool with its key ([ADR 0032](adr/0032-environments-and-runners.md)). `--capacity` caps how many sessions the agent runs at once. A session in a folder goes to an agent that lists the folder, and a session that has run goes back to the agent it ran on. A clone or several-repositories session moves to another agent in the pool if its agent stops polling for a minute; it starts again from its transcript in a fresh checkout of its branch, so only pushed work comes along. An agent that can't reach the server for 30 seconds stops those sessions itself, so two agents never run one session.

## Run it in Kubernetes

The `Dockerfile` builds an image that runs the server, and `deploy/helm/pipoca` installs it with one replica and its data on a ReadWriteOnce volume ([ADR 0034](adr/0034-v2-deployment-and-credentials.md)). On install the chart makes a Secret holding the secret key, and it keeps that Secret on upgrades and uninstalls. Put HTTPS in front with your gateway, and set `url` to where people open it:

```sh
helm install pipoca deploy/helm/pipoca --set url=https://pi.example.com
kubectl logs deploy/pipoca | grep setup
```

### On Kyma

On Kyma, `apiRule.enabled` puts the server behind Kyma's gateway at `apiRule.host`, and `url` defaults to that host:

```sh
helm install pipoca deploy/helm/pipoca --namespace pipoca --create-namespace \
  --set apiRule.enabled=true --set apiRule.host=pipoca.<cluster domain>
```

The gateway lets through only what a browser needs: the web UI, sign-in and the `/api` routes it calls. The setup link, the runner routes under `/agent` and `/api/mcp` stay closed, so open the setup link through `kubectl port-forward svc/pipoca 7420`. Runner pods reach the server through its Service, and the chart adds an Istio policy that lets pods in the namespace reach `/agent`, since the APIRule's own policies only let the gateway in. `apiRule.exposeAgents=true` opens `/agent` for runners outside the cluster, such as a laptop, and `apiRule.exposeMcp=true` opens `/api/mcp` for MCP clients.

### Single sign-on

To sign in through OpenID Connect providers, such as SAP IAS, Okta or Google ([ADR 0038](adr/0038-single-sign-on-and-admins.md)), register `<url>/api/plugins/oidc/callback` as the redirect URI with each provider. An admin adds each provider in Settings, under Single sign-on: its issuer, client ID, a client secret only if the provider requires one (the plugin uses PKCE), and who gets in, by groups from the ID token or by verified email and domain. Each provider gets its own button on the sign-in page. Link your own user from Settings first, then `oidc.ssoOnly=true` turns the password login off.

Settings keeps the providers in the server's `pipoca.json`, in its config folder next to the database ([ADR 0039](adr/0039-plugin-config-files.md)), and you can edit that file by hand too. To come up with providers already set, put them under the chart's `config` value, each with an `id`. The chart writes `config` to the data volume only when no `pipoca.json` is there yet, so after that edit the file or use Settings. A provider that needs a client secret either gets it in Settings, which stores it sealed, or names an environment variable in `clientSecretEnv`, which `extraEnv` or `extraEnvFrom` fills from a Kubernetes Secret:

```yaml
config:
  oidc:
    providers:
      - id: ias
        label: Sign in with SAP
        issuer: https://<tenant>.accounts.ondemand.com
        clientId: <client id>
        accessGroup: pipoca-users
        adminGroup: pipoca-admins
```

### Images and remote runners

Every push to main publishes the image as `ghcr.io/pedroklein/pipoca:main` and `:sha-<commit>`. Agents on other machines join it with an Environment's key, as above. `builtInRunner` also runs a runner inside the server pod.

### Runner pods

The kubernetes plugin can start runner pods for an Environment in the server's namespace ([ADR 0032](adr/0032-environments-and-runners.md)). The chart gives the server a service account that may create and delete pods and Secrets there; set `runnerPods.enabled=false` to leave that out. To make an Environment use pods, turn on runner pods in its Kubernetes section on the Environments page, or save its settings:

```sh
curl <server>/api/plugins/kubernetes/environments/<environment id> \
  -H 'content-type: application/json' --cookie <session cookie> \
  -d '{"settings": {"workspace": "pod", "capacity": 1, "maxPods": 5, "idleSeconds": 300, "podPatch": {}}}'
```

`{"settings": null}` turns them off again.

When some of its Sessions can't go to any runner, the plugin starts one pod for each `capacity` of them, up to `maxPods`. A pod runs the Environment's image, or the Pipoca image when it names none, with the `pipoca` binary copied in. Its agent stops after `idleSeconds` without a Session, and the plugin then deletes the pod and its token. A pod that hasn't started after 10 minutes is deleted too. When a pod fails, or stops without its agent ever reaching the server, the next pod for that Environment waits 10 seconds, twice as long after each failure in a row up to about 5 minutes, and the Environment's Kubernetes section shows why. `podPatch` is a JSON merge patch on the pod, such as `{"spec": {"nodeSelector": {"pool": "agents"}}}`; it can't give the pod a service account token. Only admins change these settings, since a patch can still mount the namespace's Secrets. Pods run Sessions as processes, so the Environment's isolation must be `process`. With `"workspace": "pod"`, the default, a workspace lives only as long as its pod, so use clone or repositories workspaces there. With `"workspace": "claim"`, each Session gets a pod of its own, named after it, whose home is a claim of `claimSize` (with `storageClass`, or the cluster's default). If that pod stops or is deleted, the plugin starts it again with the same claim, and the claim goes once the Session is archived.
