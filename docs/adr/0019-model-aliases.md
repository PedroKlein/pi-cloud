# 0019: Model aliases

- Status: accepted
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

### A default plugin around pi-gateway

- Model aliases are the `models` plugin in `plugins/models/`. It's on by default ([ADR 0015](0015-plugins.md)).
- Its session part loads pi-gateway and a small bridge between pi-gateway and the plugin's server part. pi-cloud doesn't copy pi-gateway's routing code.
- pi-gateway gains a `pi.events` seam that takes its config and health from another extension and reports health changes back. It already uses `pi.events` to find custom transports. Without the bridge it keeps reading and writing its own files, so it still works on its own in Pi.
- The TUI board, the config editor and oh-my-pi support stay in pi-gateway. pi-cloud doesn't use them.

### Config per Environment, on the server

- The server stores the alias config for each Environment in the plugin's tables. It has the same shape as `aliases.json`: backends, the tiers of each backend with their ordered models, the fallback chain, reset schedules and cap status codes.
- Backends are the Pi providers on that Environment's machine. Credentials stay on the machine, as ADR 0005 says.
- When a Session starts, the bridge asks the server for its Environment's config and hands it to pi-gateway.
- A config change reaches running Sessions the same way health does (below).

### Health on the server, per machine and backend

- When pi-gateway marks a backend unhealthy or healthy, the bridge reports it to the plugin's server route through the session part's `request` (ADR 0015).
- The server keeps health per Environment and backend. In v1 one Environment is one machine.
- Every Session in that Environment that uses the gateway gets the change and reroutes its next request. The bridge waits for changes on a long-polling route, so this needs no protocol addition.
- A per-minute 429 is a transient error with a short cooldown, not a daily cap. Only a backend's cap status codes and reset schedule make a cap.

### Choosing a model

- Model fields list the Environment's aliases first, as `gateway/<alias>`, then the machine's real models. That covers the new Session form, a Project's coordinator model and the model `start_thread` takes. A real model still works anywhere it did.
- An Environment can set a default alias. A Session with no model uses it, and the machine's Pi default applies only when the Environment has none.
- A Project can set an alias for its coordinator and one for its threads. `start_thread` uses the thread alias unless the coordinator names a model.
- The order is: the model named on the Session, then the Project's alias for that role, then the Environment's default, then the machine's Pi default.

### Web

- The plugin's `nav` page edits each Environment's aliases, backends and fallback chain. It lists the backends from the models that Environment's machine reports.
- The same page shows live status for each alias: the backend and real model it routes to, each backend's health and reset time, and the last model error. Model errors are only visible in transcripts today.

## Consequences

- One alias name works on every machine whose Environment defines it, so Project threads can move between the laptop and the VM without changing models.
- Sessions on one machine share what they learn about a quota, instead of each finding it on its own.
- pi-gateway needs the `pi.events` seam before the plugin can be built. That change lands in pi-extensions and a new pi-gateway release.
- pi-gateway serves one backend's credential per registration. When aliases would need two backends at once, it serves the primary backend and warns. The settings page shows that instead of a log line.
- Profiles (v2) may later carry alias config with the rest of a user's Pi setup. Until then it belongs to Environments.
