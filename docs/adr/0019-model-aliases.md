# 0019: Model aliases

- Status: accepted, amended 2026-10-21 (pi-cloud has its own gateway on Pi virtual models instead of reusing pi-gateway)
- Date: 2026-10-21

## Context

A Session names its model as `provider/model`, and each machine has its own Pi models and credentials ([ADR 0005](0005-v1-access-and-model-credentials.md)). The laptop and the VM have different providers, so the same name rarely works on both. A Project's coordinator and its threads can run in different Environments ([ADR 0014](0014-concept-map-and-environments.md)), so `start_thread` can't name one model that works wherever a thread lands.

The v1 acceptance run showed the cost of this ([acceptance](../acceptance/v1.md)). Free-tier quotas ran out within seconds, because every Session process found the same per-minute limit on its own and Pi doesn't retry quota errors.

[pi-gateway](https://github.com/PedroKlein/pi-extensions/tree/main/packages/pi-gateway) already solves this for a single machine:

- It registers a `gateway` provider with tier aliases (`heavy-1`, `medium-1`, `light-1`), and each alias routes to an ordered list of real models.
- A fallback chain of backends moves an alias to the next healthy backend.
- A cap or a transient error that comes before any output is replayed on the next backend in the same turn.
- Health and reset times are kept per backend.
- Its config is a pure mapping in `aliases.json`, with no credentials in it. It keeps health in `gateway-state.json`, and edits both from a TUI board.

## Decision

### pi-cloud's own gateway, as a default plugin

- Model aliases are the `models` plugin in `plugins/models/`. It's on by default ([ADR 0015](0015-plugins.md)).
- pi-cloud has its own gateway. pi-gateway is a reference, as [ADR 0001](0001-own-the-control-plane-and-ui.md) treats other projects. An earlier version of this ADR reused pi-gateway through a `pi.events` seam. That meant an npm release for every change and a guard for Sessions that load both copies.
- The session part registers each alias as a Pi virtual model, `alias/<alias>`. The provider isn't `gateway`, so a machine that also runs pi-gateway keeps its `gateway/*` models. Pi calls its `route` before every request, and it returns the first healthy backend's model that has credentials on the machine. Pi keeps the backends' own providers, auth and streaming, so pi-cloud needs no transport of its own.
- A tool follow-up or a retry stays on the model that answered while its backend is healthy, which keeps the prompt cache.
- pi-gateway replays a failed request on the next backend in the same turn. Pi already retries rate limits and server errors, and that retry routes to the next backend. Pi doesn't retry a quota or billing cap, so that turn ends with the error and the next request goes to the next backend.
- The alias names follow pi-gateway: `<tier>-<n>`, where the count per tier comes from the first backend in the chain that has the tier.

### Config per Environment, on the server

- The server stores the alias config for each Environment in the plugin's tables. It has the same shape as `aliases.json`: backends, the tiers of each backend with their ordered models, the fallback chain, reset schedules and cap status codes.
- Backends are the Pi providers on that Environment's machine. Credentials stay on the machine, as ADR 0005 says.
- When a Session starts, the session part reads its Environment's config from the plugin's server route.
- A config change reaches running Sessions the same way health does (below).

### Health on the server, per machine and backend

- When a response through an alias fails with a cap or a transient error, the session part marks its backend unhealthy and reports it to the plugin's server route through `request` (ADR 0015). The server keeps, per backend, the later of the reset times it hears about.
- The server keeps health per Environment and backend. In v1 one Environment is one machine.
- Every Session in that Environment that uses the gateway gets the change and reroutes its next request. The session part waits for changes on a long-polling route, so this needs no protocol addition.
- A per-minute 429 is a transient error with a one-minute cooldown, not a cap. A cap comes from a backend's cap status codes (402 unless set) or from quota and billing wording, and lasts until its reset schedule, or an hour.

### Choosing a model

- Model fields list the Environment's aliases first, as `alias/<alias>`, then the machine's real models. That covers the new Session form, a Project's coordinator model and the model `start_thread` takes. A real model still works anywhere it did.
- An Environment can set a default alias. A Session with no model uses it, and the machine's Pi default applies only when the Environment has none.
- A Project can set a model for its coordinator and one for its threads, usually aliases. `start_thread` uses the thread model unless the coordinator names one.
- The plugin gives the kernel its aliases and default through a model offer (ADR 0015), so the kernel's model fields and start request need no Project or alias code.
- The order is: the model named on the Session, then the Project's alias for that role, then the Environment's default, then the machine's Pi default.

### Web

- The plugin's `nav` page edits each Environment's aliases, backends and fallback chain. It lists the backends from the models that Environment's machine reports.
- The same page shows live status for each alias: the backend and real model it routes to, each backend's health and reset time, and the last model error. Model errors are only visible in transcripts today.

## Consequences

- One alias name works on every machine whose Environment defines it, so Project threads can move between the laptop and the VM without changing models.
- Sessions on one machine share what they learn about a quota, instead of each finding it on its own.
- pi-cloud owns about 300 lines of routing code that can drift from pi-gateway. Virtual models keep it small: pi-gateway's custom transport and single-credential registration aren't needed.
- A quota cap costs the turn it happens in. Same-turn replay can come later if that hurts.
- Profiles (v2) may later carry alias config with the rest of a user's Pi setup. Until then it belongs to Environments.
