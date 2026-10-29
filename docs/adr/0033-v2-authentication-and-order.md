# 0033: v2 Authentication and Build Order

- Status: accepted, amended 2026-10-25 (meta-sessions become step 5, [ADR 0035](0035-meta-sessions.md); third-party install and in-place plugins become step 6; automation plugins leave v2) and 2026-10-29 (failed password sign-ins count per name and client address)
- Date: 2026-10-24

## Context

v1 has no authentication. The Control Plane listens on localhost and is reached there or through an SSH tunnel, and so are Provider Agents on other machines ([ADR 0005](0005-v1-access-and-model-credentials.md)). [vision.md](../vision.md#v2-execution-platform) adds authentication in v2 for the web UI and for enrolling Provider Agents, once the Control Plane is reachable beyond a tunnel. Runners in a Kubernetes cluster usually are ([ADR 0032](0032-environments-and-runners.md)). Claude Code's self-hosted runners register with a per-environment key ([self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments)).

v2's other decisions are in [ADR 0022](0022-plugin-model-v2.md) (plugins), [ADR 0031](0031-profiles.md) (Profiles) and ADR 0032 (Environments and runners). They depend on each other, so they need an order.

## Decision

### Authentication

- The kernel has users, browser sessions and runner keys. Records already carry `ownerId` ([ADR 0015](0015-plugins.md#actors-and-owners)).
- The kernel comes with a password login, so a personal install needs nothing outside Pi Cloud.
- Signing in through an OIDC provider, such as GitHub, Google or a company identity provider, is a first-party plugin ([ADR 0038](0038-single-sign-on-and-admins.md)).
- A browser session is an `HttpOnly; SameSite=Strict` cookie, which also covers WebSocket upgrades. No key is kept in `localStorage` ([v2-ideas.md](../v2-ideas.md#authentication-once-v1s-no-auth-rule-ends)).
- A runner joins an Environment's pool with that Environment's key, and gets a token of its own for its polls and streams.
- Failed password sign-ins count per name and client address: ten in 15 minutes lock that name from that address, and 50 for any names lock the address. Guessing stays slow from any one place, and a stranger elsewhere can't lock a person out. The server takes the address from `X-Forwarded-For` only with `--trust-proxy`, which the Helm chart sets behind Kyma's gateway (decided 2026-10-29; until then ten failures locked a name for everyone).
- A loopback bind needs a login and runner keys too, as in Claude Code. Other local users and DNS-rebinding pages can reach a loopback port, and one code path is tested everywhere (decided 2026-10-25).

### Build order

1. Profiles (ADR 0031).
2. Environments as pools: leases, resume on another runner, container isolation, image and setup script, variables and secrets (ADR 0032).
3. Authentication.
4. The `kubernetes` plugin (ADR 0032).
5. Meta-sessions, their toolsets and the MCP endpoint ([ADR 0035](0035-meta-sessions.md)).
6. Third-party plugin install ([ADR 0022](0022-plugin-model-v2.md#installing-third-party-plugins)) and in-place plugins written by meta-sessions ([ADR 0035](0035-meta-sessions.md#in-place-plugins)).

(Amended 2026-10-25: automation plugins, meaning Jobs, AI workflows and software factories, were step 7. They are no longer part of v2, which already has enough to ship. They come later and are designed in their own discussion first.)

Each step is tested on the laptop and the VM before the next, as v1 was. The plugin pieces of ADR 0022 (Session tabs, code blocks, previews and the manifest) don't depend on these and are built between steps.

## Consequences

- Kubernetes comes after Profiles, pools and authentication are in the kernel.
- Automation plugins, when they come, build on every seam above and are designed with their meta toolsets.
- Until step 3, Pi Cloud stays behind localhost and SSH tunnels.
- Login methods follow the same rule as other features: the kernel has the minimum, and the rest are plugins.
- Server-held Environment secrets from ADR 0032 sit behind a login from step 3 on.
