# 0002: TypeScript for all components

- Status: accepted
- Date: 2026-10-16

## Context

Pi Cloud has six components:

| Component      | Runs where                                                           |
| -------------- | -------------------------------------------------------------------- |
| Control Plane  | One per Cell: VM, Kubernetes namespace, or laptop                    |
| Web UI         | Browser, served by the Control Plane                                 |
| Provider Agent | One per laptop, VM, or Kubernetes namespace                          |
| Session host   | Wherever Pi runs: in the Provider Agent process, or in a Session pod |
| Session bridge | Inside every Pi Session, as a Pi extension                           |
| Protocol       | Shared library used by the four runtime components                   |

Pi is written in TypeScript. The Session bridge is a Pi extension and must be TypeScript. The Session host should embed Pi through its SDK, which exposes far more than RPC mode, so it is TypeScript too. The browser UI is effectively TypeScript.

Only the Control Plane and Provider Agent were open. Go suits Kubernetes controllers and static binaries.

## Decision

All components are written in TypeScript. Protocol types are defined once and shared.

## Consequences

- One toolchain, one test setup, and no duplicated protocol definitions across languages.
- The Kubernetes provider uses a TypeScript Kubernetes client. If that proves inadequate for controller work, a Go component behind the same protocol can be reconsidered in a new ADR.
- Runtime and package manager are decided in [ADR 0003](0003-bun-runtime-and-workspaces.md).
