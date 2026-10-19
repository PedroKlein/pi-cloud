# Pi Cloud

Pi Cloud is the working product and repository name for a self-hosted control plane for persistent, personalized Pi sessions across local machines, VMs, and Kubernetes. The direct name is intentional; branding can change later without changing the architecture.

The intended product supports ordinary independent sessions and long-running Projects. A Project has one coordinator session and any number of full thread sessions. Every thread is a normal Pi session with its own context, workspace, and subagents.

The design is still exploratory. The first slice runs one independent Session on a local agent with a minimal web UI.

## Run it

```sh
bun install
bun run build
apps/pi-cloud/dist/pi-cloud server
apps/pi-cloud/dist/pi-cloud agent --name laptop
```

Open http://127.0.0.1:7420, create a session with provider `laptop` and a directory on this machine, and chat. The agent uses the models and logins of your own Pi setup.

## Current direction

- Preserve Pi's package, extension, skill, prompt, MCP, model, and instruction system.
- Treat personalization as a versioned Profile, not machine-local incidental state.
- Let sessions select reusable Environments backed by local, VM, or Kubernetes Runtime Providers.
- Keep one logical personal control plane authoritative for Projects, Sessions, Environments, and shared state.
- Keep Projects logical: they coordinate full sessions but are not themselves an execution sandbox.
- Design public extension seams so future scheduling, automations, integrations, and collaboration do not require a second execution system.

## Documentation

- [Vision](docs/vision.md): agreed goal, product principles, scope, and non-goals.
- [Concepts](docs/concepts.md): shared vocabulary and resource relationships.
- [Working architecture](docs/architecture.md): control-plane, provider, Session, state, lifecycle, and deployment model.
- [Environments](docs/environments.md): local, VM, Kubernetes, setup, policy, capability, and revision model.
- [Extensibility](docs/extensibility.md): Profiles, Pi personalization, platform extensions, automations, and collaboration direction.
- [Existing Pi ecosystem](docs/pi-ecosystem.md): boundaries and reuse opportunities across Pi and current extensions.
- [Open questions](docs/open-questions.md): decisions that remain unresolved.
- [Research](docs/research.md): facts learned from Claude Projects, cloud environments, and related open-source systems.
- [Decisions](docs/adr/): accepted architecture decision records.

Future discussions should treat these documents as a checkpoint, not as frozen requirements. When a decision is made, record it separately as an ADR rather than silently turning a working assumption into fact.

## Continue the design

A focused follow-up Session should read `docs/vision.md`, `docs/concepts.md`, and the relevant section of `docs/open-questions.md`, then consult the deeper topic document. Resolve one decision cluster at a time; update open questions while exploring and create an ADR only after the choice and consequences are understood.

Example:

> Read the Pi Cloud vision and concepts, then focus on the control-plane and protocol questions. Preserve agreed direction, challenge working assumptions, and produce a decision only where the evidence is sufficient.
