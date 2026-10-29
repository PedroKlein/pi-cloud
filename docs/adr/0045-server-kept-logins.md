# 0045: Server-Kept Logins

- Status: accepted
- Date: 2026-10-29

## Context

Each runner keeps its own model logins in its data folder ([ADR 0031](0031-profiles.md)), and `/login` from the web writes there ([ADR 0024](0024-provider-login-from-the-web.md)). This causes three problems.

- People log in again on every runner, and a Kubernetes runner forgets its logins when its pod exits ([ADR 0044](0044-base-profile.md#credentials)).
- Pi keeps MCP sign-ins in `mcp-auth.json` in the agent folder, which on a runner is its copy of the Profile. A Profile sync or a new pod drops them, and the web has no way to sign in to an MCP server.
- Pi signs in with the browser by redirecting to a loopback address on the machine that runs the login. When that machine is a runner, the browser on the person's device can't reach it.

ADR 0044 left per-person credentials for v3. Git hosts already went per person ([ADR 0043](0043-git-hosts.md)), and the same shape fits here.

## Decision

### Per person, on the server

- The server keeps each person's model and MCP logins, and their Sessions use them on every runner (decided 2026-10-29). This replaces the per-runner auth file in ADR 0031.
- Logins are runtime data, so they live sealed in SQLite, not in the config folder ([ADR 0039](0039-plugin-config-files.md)). A first-party `logins` plugin owns them, its routes and its Settings page.
- A Session uses the logins of the person who started it, as git hosts do. Environment secrets keep working as environment variables, so an API key there still reaches every Session in the Environment.

### Runners go through the server

- A runner reads and writes a person's logins through the server instead of a local file (decided 2026-10-29). Pi's auth storage takes a backend with a lock (`AuthStorageBackend`), and its MCP credential store takes the same backend, so the Session host swaps the file for one that calls the server.
- The server holds a short lock per person and file while a runner reads, refreshes and writes back. Many providers rotate refresh tokens, so two runners refreshing at once would otherwise lose the login.
- Runners get refresh tokens, not only access tokens. Refresh code for extension providers, such as `pi-aicore-provider`, runs where the extension loads, which is the runner. A Session can already read its runner's auth file and its Environment secrets, so this exposes nothing new. Keeping tokens away from Sessions belongs with brokered secrets ([ADR 0032](0032-environments-and-runners.md)).
- A runner that can't reach the server fails the call with a clear error instead of falling back to a local file.

### Signing in on the person's device

- Settings gets a Logins page listing model providers and the MCP servers in the base Profile and the person's Profiles, each with Connect and Disconnect. A Session isn't needed. `/login` and `/logout` in a Session save to the same place.
- The server runs the sign-in, and the provider's page opens in a new tab on the device where the UI is open.
- MCP servers redirect to Pipoca's public address (`/api/plugins/logins/callback`), since Pi's MCP sign-in registers its redirect address with dynamic client registration or a client metadata document. The tab finishes by itself, like Connect on git hosts.
- Providers with device codes, such as GitHub Copilot, work as they are.
- Providers whose fixed redirect is a loopback address, such as OpenAI Codex and Anthropic, end on a page that can't load. Pipoca shows a field for the address the tab landed on, and Pi's own fallback for a pasted redirect address finishes the login (decided 2026-10-29). This works on any device, including a phone.
- API keys that Pi's `/login` accepts are saved the same way.

### Moving over

- Logins already on a runner are not copied. People connect each provider once on the Logins page.

## Consequences

- One login per person per provider or MCP server, kept across runners, pods and Profile syncs.
- Starting a Session's model call or MCP connection depends on the server being reachable, which runners already need for their work.
- Codex and Anthropic sign-ins need one paste each. Catching the loopback redirect with a Pipoca agent on the person's own device can come later.
- Answers "How do people bring their own provider credentials when several share an installation?" for model and MCP logins, ahead of the v3 plan in ADR 0044.
