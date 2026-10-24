# 0033: v2 Authentication and Build Order

- Status: accepted
- Date: 2026-10-24

## Context

v1 has no authentication. The Control Plane listens on localhost and is reached there or through an SSH tunnel, and so are Provider Agents on other machines ([ADR 0005](0005-v1-access-and-model-credentials.md)). [vision.md](../vision.md#v2-execution-platform) adds authentication in v2 for the web UI and for enrolling Provider Agents, once the Control Plane is reachable beyond a tunnel. Runners in a Kubernetes cluster usually are ([ADR 0032](0032-environments-and-runners.md)). Claude Code's self-hosted runners register with a per-environment key ([self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments)).

v2's other decisions are in [ADR 0022](0022-plugin-model-v2.md) (plugins), [ADR 0031](0031-profiles.md) (Profiles) and ADR 0032 (Environments and runners). They depend on each other, so they need an order.

## Decision

### Authentication

- The kernel has users, browser sessions and runner keys. Records already carry `ownerId` ([ADR 0015](0015-plugins.md#actors-and-owners)).
- The kernel comes with a password login, so a personal install needs nothing outside Pi Cloud.
- Signing in through an OIDC provider, such as GitHub, Google or a company identity provider, is a first-party plugin.
- A browser session is an `HttpOnly; SameSite=Strict` cookie, which also covers WebSocket upgrades. No key is kept in `localStorage` ([v2-ideas.md](../v2-ideas.md#authentication-once-v1s-no-auth-rule-ends)).
- A runner joins an Environment's pool with that Environment's key, and gets a token of its own for its polls and streams.
- Whether a loopback bind may still skip login, as in v1, is decided when this is built.

### Build order

1. Profiles (ADR 0031).
2. Environments as pools: leases, resume on another runner, container isolation, image and setup script, variables and secrets (ADR 0032).
3. Authentication.
4. The `kubernetes` plugin (ADR 0032).

Each step is tested on the laptop and the VM before the next, as v1 was. The plugin pieces of ADR 0022 (Session tabs, code blocks, previews, the manifest and third-party install) don't depend on these and are built between steps.

## Consequences

- Kubernetes comes last, on a kernel that already has Profiles, pools and authentication.
- Until step 3, Pi Cloud stays behind localhost and SSH tunnels.
- Login methods follow the same rule as other features: the kernel has the minimum, and the rest are plugins.
- Server-held Environment secrets from ADR 0032 sit behind a login from step 3 on.
