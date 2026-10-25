# 0037: Previews and opened pages

- Status: accepted
- Date: 2026-10-25

## Context

Some Pi extensions start a small web server next to the agent and open a browser on it. [Plannotator](https://github.com/backnotprop/plannotator) does this for every plan or code review: it serves its UI on a local port, runs `$BROWSER <url>`, ends the turn, and gets the decision back when the user clicks in that UI. CLIs such as `gh browse` open pages the same way.

On a laptop runner this opens a tab on the laptop, which doesn't help from a phone. On a VM, in a container or in a pod there is no browser to open, and a `localhost` link in the chat points at the user's own machine.

[ADR 0022](0022-plugin-model-v2.md#previews) designed previews: the server proxies a Session's port at its own origin, `<port>--<session>.<host>`. It left open how a port gets exposed, how the user signs in on that origin, and how a page the Session opens reaches the user.

## Decision

### Pi Cloud is the Session's browser

- The Session host sets `BROWSER` to a small script in the Session's folder. The script runs `pi-cloud open <url>`, which hands the URL to the Session host over a loopback port with a random token. It works the same in a container, since the binary and the folder are mounted there.
- The Session host keeps the last five pages it was asked to open and publishes them as live state. The web shows them above the composer, each with Open and Dismiss.
- A page on the Session's own machine (`localhost`, `127.0.0.1`, `[::1]` or `0.0.0.0` over HTTP) opens through a preview. Any other page opens as a plain link.
- A local page goes once nothing listens on its port, checked every few seconds. Plannotator's card goes away once the review is answered.

### Only opened ports are previewed

- A preview reaches a port only while a page the Session opened is on it. Other ports of the Session stay closed, even to signed-in users.
- Other ways to expose a port, such as a tool or a button, can be added later and use the same list.

### Signing in on a preview's origin

- Pi Cloud's cookie is host-only and never reaches a preview's origin, and a preview's cookie never reaches Pi Cloud's.
- Open goes to `/api/sessions/<id>/previews/<port>` on Pi Cloud's origin. It checks the user's session, makes a one-time grant that lasts a minute, and redirects to the preview's origin with it.
- The preview's origin trades the grant for its own `HttpOnly` cookie, valid for that Session and port for 12 hours, and redirects to the page. The server keeps grants and cookies in memory, so a restart means opening the page again.
- The proxy strips that cookie before the request reaches the app.

### The proxy

- Each request travels like a terminal ([ADR 0006](0006-provider-protocol.md)): the server sends the Session a `preview` command, and the Session host opens a socket back to the server for that one request. The request goes over it, and the answer streams back. Slow streams, such as server-sent events, stay open.
- The Session host sends the request with the `Host`, `Origin` and `Referer` the app would see from its own origin. Plannotator and dev servers refuse other hosts and cross-origin writes, against DNS rebinding. Redirects to the app's own origin become paths.
- Bun matches routes before `fetch` and on every host, so the web UI moves from the `/` route to an internal path. `/` on Pi Cloud's own host still serves it.
- Only HTTP is proxied for now. WebSockets, which dev servers use for live reload, come next.
- Previews need Pi Cloud opened under a name. Browsers resolve `*.localhost` to the loopback address, which covers a laptop and an SSH tunnel; Chromium was checked. An IP address can't have subdomains, so Open explains that instead. A public host needs a wildcard DNS name, which isn't set up yet.

### Compared with Claude Code

Claude Code's browser lives in its desktop app, which reaches the dev server locally ([ADR 0022](0022-plugin-model-v2.md#no-browser-plugin-yet)). GitHub Codespaces also forwards each port on a subdomain of its own.

## Consequences

- Plannotator works on every runner with no change to it, and so does any tool that honors `BROWSER`.
- A user's shell in the Terminal tab doesn't get `BROWSER`, since the agent opens it outside the Session host.
- Plannotator's own "opened at http://localhost:..." notice still shows the local address. The Open button next to the composer is the one that works.
- `/__pi-cloud/` paths and the web UI's chunk files are taken on a preview's origin. Apps rarely use them.
