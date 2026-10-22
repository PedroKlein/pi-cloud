# 0005: v1 access and model credentials

- Status: accepted, amended by [ADR 0024](0024-provider-login-from-the-web.md) (provider login from the web)
- Date: 2026-10-17

## Context

v1 runs on the user's laptop or on one VM ([vision](../vision.md#scope)). The user reaches a VM through an SSH tunnel. Hosted Sessions need model credentials, and Pi already stores its own provider auth on each machine.

## Decision

- v1 has no application-level authentication. The Control Plane listens on localhost only and is reached locally or through an SSH tunnel. Provider Agents on other machines connect through a tunnel as well.
- Each provider uses its own Pi auth for model credentials. No model keys or tokens pass through or are stored by the Control Plane.

## Consequences

- No login, token, or TLS work is needed for the first slice.
- Anyone who can reach the localhost port has full control, so the Control Plane must never bind to a public interface in v1.
- A user must log Pi in on each provider machine.
- Authentication and credential brokering return as decisions when the Control Plane is exposed beyond a tunnel or reaches v2.
