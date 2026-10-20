# Run the server on a VM

This sets up `pi-cloud server` on a Linux VM with a built-in provider named `vm`, under a systemd user service, and reaches it from your laptop through an SSH tunnel. Sessions on that provider clone a repository into their own directory and work on their own branch ([ADR 0012](adr/0012-built-in-provider.md)).

## On the VM

Sessions use the VM's own tools, so set these up first as the user that will run the server:

- git, with credentials for the repositories you'll clone (an SSH key or a credential helper). Pi Cloud never prompts for them.
- Pi, logged in to at least one model. Check with `pi` once.
- Whatever your projects need to build and test.

## Build and copy the binary

From a checkout on your laptop, build for the VM's platform and copy it over:

```sh
bun install
bun build --compile --target=bun-linux-x64 apps/pi-cloud/src/main.ts --outfile dist/pi-cloud-linux
scp dist/pi-cloud-linux <vm>:~/.local/bin/pi-cloud
```

Use `--target=bun-linux-arm64` for an ARM VM.

## Install the service

On the VM, save this as `~/.config/systemd/user/pi-cloud.service`:

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

The server listens on `127.0.0.1:7420`. Its database is `~/.pi-cloud/server.db`, and clones and Pi transcripts live under `~/.pi-cloud/server`.

To update, copy a new binary over and run `systemctl --user restart pi-cloud`. Running Sessions are interrupted and reload idle from their transcript.

## From the laptop

Open a tunnel and keep it running:

```sh
ssh -N -L 7420:127.0.0.1:7420 <vm>
```

Open http://127.0.0.1:7420, choose "Clone repository", enter provider `vm` and a repository URL the VM can clone, and start the session.

To also run sessions on the laptop, start an agent against the tunnel:

```sh
pi-cloud agent --name laptop
```
