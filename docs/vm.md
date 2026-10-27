# Run the server on a VM

This sets up `pipoca server` on a Linux VM with a built-in provider named `vm`, under a systemd user service, and reaches it from your laptop through an SSH tunnel. Sessions on that provider clone a repository into their own directory and work on their own branch ([ADR 0012](adr/0012-built-in-provider.md)).

## On the VM

Sessions use the VM's own tools, so set these up first as the user that will run the server:

- git, with credentials for the repositories you'll clone (an SSH key or a credential helper). Pipoca never prompts for them.
- Nothing from your own Pi setup. Sessions take their packages, instructions and settings from their Profile, which you edit on the Profiles page, and never read `~/.pi/agent` ([ADR 0031](adr/0031-profiles.md)). Log the VM in to a model provider from any Session with `/login`. The login is kept in the server's data directory (`~/.pipoca/server/logins/auth.json` by default) and serves every Profile on the VM. Custom model providers go in `models.json` in the same folder, in Pi's own format. Settings a Session changes from inside Pi, such as with `/settings` or `/mcp`, last until its next start: the Profile on the server is what every start uses.

- Whatever your projects need to build and test.

## Build and copy the binary

From a checkout on your laptop, build for the VM's platform and copy it over:

```sh
bun install
ssh <vm> mkdir -p .local/bin
bun run --cwd apps/pipoca build --target=bun-linux-x64 --outfile ../../dist/pipoca-linux
scp dist/pipoca-linux <vm>:~/.local/bin/pipoca
```

Use `--target=bun-linux-arm64` for an ARM VM. The build script also compiles the worker that runs Pi's `codemode` scripts, which a plain `bun build --compile src/main.ts` leaves out.

## Install the service

On the VM, run `mkdir -p ~/.config/systemd/user` and save this as `~/.config/systemd/user/pipoca.service`:

```ini
[Unit]
Description=Pipoca server

[Service]
# A login shell gives Sessions the same PATH and tools as your SSH sessions.
ExecStart=/bin/bash -lc 'exec %h/.local/bin/pipoca server --provider vm'
Restart=on-failure

[Install]
WantedBy=default.target
```

A login shell reads `~/.profile`, not `~/.bashrc`, so put the PATH entries your Sessions need there. Bun's installer writes to `~/.bashrc`; without `export PATH="$HOME/.bun/bin:$PATH"` in `~/.profile`, Sessions can't find `bun`.

Then start it, and let it keep running after you log out:

```sh
systemctl --user daemon-reload
systemctl --user enable --now pipoca
loginctl enable-linger "$USER"
journalctl --user -u pipoca -f
```

To keep the key that encrypts Environment secrets away from the database and its backups, write it to its own file and add `EnvironmentFile=%h/.config/pipoca/secret.env` under `[Service]`:

```sh
mkdir -p ~/.config/pipoca
(umask 077; echo "PIPOCA_SECRET_KEY=$(openssl rand -base64 32)" > ~/.config/pipoca/secret.env)
```

The server listens on `127.0.0.1:7420`. Its database is `~/.pipoca/server.db`, and clones and Pi transcripts live under `~/.pipoca/server`. `curl -s 127.0.0.1:7420/healthz` returns the running version and the Pi version it bundles, or a 503 when the database can't be read.

To update, copy the new binary next to the old one and move it into place, because the running server keeps the old file busy and `scp` can't overwrite it. Then restart the service:

```sh
scp dist/pipoca-linux <vm>:~/.local/bin/pipoca.new
ssh <vm> 'chmod +x ~/.local/bin/pipoca.new && mv ~/.local/bin/pipoca.new ~/.local/bin/pipoca && systemctl --user restart pipoca'
```

Running Sessions are interrupted and reload idle from their transcript. A tool that was running when the service stopped is recorded as interrupted by a restart. `/healthz` shows the new version once the server is back.

## From the laptop

Open a tunnel and keep it running:

```sh
ssh -N -L 7420:127.0.0.1:7420 <vm>
```

If your SSH config uses `ControlMaster`, this command returns right away while the forward stays up on the shared connection. `ssh -O cancel -L 7420:127.0.0.1:7420 <vm>` removes it.

The server logs a one-time setup link the first time it starts (`journalctl --user -u pipoca | grep setup`). Open it through the tunnel to create your user, then sign in with it.

Open http://127.0.0.1:7420, open New session, choose the `vm` Environment, paste a repository URL the VM can clone into the folder chip, and start the session. The session's branch starts from the repository's default branch, or from the branch, tag or commit you enter in the "from" chip.

To also run sessions on the laptop, make a `laptop` Environment on the Environments page and start an agent against the tunnel with the key it shows:

```sh
PIPOCA_KEY=pck_… pipoca agent --name laptop
```
