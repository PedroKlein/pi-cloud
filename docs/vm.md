# Run the server on a VM

This sets up `pi-cloud server` on a Linux VM with a built-in provider named `vm`, under a systemd user service, and reaches it from your laptop through an SSH tunnel. Sessions on that provider clone a repository into their own directory and work on their own branch ([ADR 0012](adr/0012-built-in-provider.md)).

## On the VM

Sessions use the VM's own tools, so set these up first as the user that will run the server:

- git, with credentials for the repositories you'll clone (an SSH key or a credential helper). Pi Cloud never prompts for them.
- A Pi login for at least one model, in `~/.pi/agent`. The binary bundles Pi, so the `pi` command isn't needed to run sessions, only to log in. Either install it and use `/login`, or copy `auth.json` from a machine that is already logged in. The `pi` launcher expects Node, so on a VM with only Bun run it through Bun:

  ```sh
  curl -fsSL https://bun.sh/install | bash
  ~/.bun/bin/bun add -g @earendil-works/pi-coding-agent
  ~/.bun/bin/bun --bun ~/.bun/bin/pi
  ```

  In Pi, use `/login`, then `/model` to save the default model that sessions will use. The server creates an empty `~/.pi/agent/auth.json` when it first starts, so that file existing doesn't mean Pi is logged in. If an extension adds your model provider, copy the extension and `settings.json` too.

- Whatever your projects need to build and test.

## Build and copy the binary

From a checkout on your laptop, build for the VM's platform and copy it over:

```sh
bun install
ssh <vm> mkdir -p .local/bin
bun build --compile --target=bun-linux-x64 apps/pi-cloud/src/main.ts --outfile dist/pi-cloud-linux
scp dist/pi-cloud-linux <vm>:~/.local/bin/pi-cloud
```

Use `--target=bun-linux-arm64` for an ARM VM.

## Install the service

On the VM, run `mkdir -p ~/.config/systemd/user` and save this as `~/.config/systemd/user/pi-cloud.service`:

```ini
[Unit]
Description=Pi Cloud server

[Service]
# A login shell gives Sessions the same PATH and tools as your SSH sessions.
ExecStart=/bin/bash -lc 'exec %h/.local/bin/pi-cloud server --provider vm'
Restart=on-failure

[Install]
WantedBy=default.target
```

Then start it, and let it keep running after you log out:

```sh
systemctl --user daemon-reload
systemctl --user enable --now pi-cloud
loginctl enable-linger "$USER"
journalctl --user -u pi-cloud -f
```

The server listens on `127.0.0.1:7420`. Its database is `~/.pi-cloud/server.db`, and clones and Pi transcripts live under `~/.pi-cloud/server`. `curl -s 127.0.0.1:7420/healthz` returns the running version, or a 503 when the database can't be read.

To update, copy the new binary next to the old one and move it into place, because the running server keeps the old file busy and `scp` can't overwrite it. Then restart the service:

```sh
scp dist/pi-cloud-linux <vm>:~/.local/bin/pi-cloud.new
ssh <vm> 'chmod +x ~/.local/bin/pi-cloud.new && mv ~/.local/bin/pi-cloud.new ~/.local/bin/pi-cloud && systemctl --user restart pi-cloud'
```

Running Sessions are interrupted and reload idle from their transcript. `/healthz` shows the new version once the server is back.

## From the laptop

Open a tunnel and keep it running:

```sh
ssh -N -L 7420:127.0.0.1:7420 <vm>
```

If your SSH config uses `ControlMaster`, this command returns right away while the forward stays up on the shared connection. `ssh -O cancel -L 7420:127.0.0.1:7420 <vm>` removes it.

Open http://127.0.0.1:7420, choose the `vm` Environment and "Clone repository", enter a repository URL the VM can clone, and start the session. The session's branch starts from the repository's default branch, or from the branch, tag or commit you enter under "start from".

To also run sessions on the laptop, start an agent against the tunnel:

```sh
pi-cloud agent --name laptop
```
