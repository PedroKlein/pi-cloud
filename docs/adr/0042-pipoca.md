# 0042: Pipoca

- Status: accepted
- Date: 2026-10-27

## Context

The product has been called Pi Cloud since the first commit. The name no longer fits, for three reasons:

- An unrelated npm package, `pi-cloud`, is a self-hosted web workspace for the Pi coding agent, which is close to what this is.
- Earendil, which makes Pi, has said it plans commercial additions that include cloud infrastructure. "Pi Cloud" reads like an official product and could collide with one.
- The product isn't a cloud. It runs Sessions on a laptop, a VM or a cluster, and grows into the place a team works with Pi ([vision](../vision.md)).

The new name had to be catchy, easy to say, easy to draw, tied to Pi, and unused in AI and developer tooling. More than seventy names were checked against npm, GitHub, `.dev` domains and products in the field. Most of the good ones were taken by agent tools in 2026, including Pier, Harbor, Radian, Tau, Roost and Hangar.

## Decision

### The name

The product is **Pipoca**, Portuguese for popcorn. Pi is in the word, and the idea fits the design: a small kernel that pops into plugins ([ADR 0015](0015-plugins.md)).

- It is written as one lowercase word, `pipoca`, wherever people type it: the binary, npm, URLs, environment variables and folders. In prose it is Pipoca.
- It is never written `pi-poca`, since the hyphen splits it into two words. `πpoca` is only for stickers and swag, since nobody can type π into a terminal, a URL or a search box.
- On 2026-10-25 the npm name `pipoca`, the `@pipoca` scope, `pipoca.dev` and the Pi package `pi-pipoca` were all free, and no AI or developer tool used the name.

### The identity

- The mark is a popped kernel: six butter circles for the puff over a small ink hull. It must work at 16px, so it has no outlines or thin parts.
- The wordmark is `pipoca` in Newsreader Light, lowercase and tracked tight. In the logo, a small puff replaces the dot on the i; at small sizes the dot is plain.
- The palette is Butter `#F3C552`, Ivory `#FAF7F0`, Ink `#1A1712`, Hull `#7A4A24` and Puff `#FFF8E7`. A cinema red, `#C8553D`, is only for illustration.
- The type is Hanken Grotesk for the interface, Newsreader for the wordmark and large headings, and JetBrains Mono for code.

### In the app

- The app keeps the quiet console of the current design and its state colours: teal for working, amber for waiting, green for done and red for failed.
- Butter isn't the app's accent, since it sits between amber and red and would read as a state. Ink is the accent in the light theme and Puff is the accent in the dark theme. Butter shows only in the mark.
- The neutrals move from cool greys to Ivory and Ink, so the app matches the mark.

### What renames

- The repository, the binary, the `apps/pi-cloud` folder, the `@pi-cloud/*` packages, the `piCloud` field in a plugin's `package.json`, the `PI_CLOUD_*` environment variables, the image, the Helm chart and every name shown to people all become `pipoca`, `@pipoca/*`, `pipoca` and `PIPOCA_*`.
- The data folder moves from `~/.pi-cloud` to `~/.pipoca`, and the config file from `pi-cloud.json` to `pipoca.json`. On start, if the new one is missing and the old one exists, Pipoca renames the old one and logs it, so the Mac, the VM and the cluster keep their data.
- Transcripts that carry the old custom message types still render, and branches made under `pi-cloud/` keep their stored base and pull request.
- The Helm chart keeps naming its resources after the release, so the cluster install keeps its release name and volume.

## Consequences

- Users sign in again, since the cookie names change, and the web UI forgets its local preferences once.
- A runner on the old binary can't join a new server, as with any protocol change. Each machine needs the new binary.
- Runner pods made before the change keep the old labels, and the server doesn't clean them up. They are deleted by hand once.
- GitHub redirects the old repository URL after the rename, but the old image name stops getting new builds.
- The `@pipoca` scope and `pipoca.dev` still have to be claimed before someone else takes them.
