# 0014: Concept map and Environments

- Status: accepted, Profiles amended by [ADR 0031](0031-profiles.md)
- Date: 2026-10-21

## Context

[concepts.md](../concepts.md) names Session, Project, Profile, Environment, Runtime Provider, Runtime and Workspace, but doesn't say how they relate or which of them a Session points at. Projects are next, and a Project needs a default place for its Sessions to run.

Today a Session names a provider directly. No Environment exists in the code. If Projects also point at a provider, v2 has to move every Project and Session from providers to Environments when Environments gain setup, variables, network policy and provider pools.

Claude Code keeps these apart. Environments are their own settings objects: network access, variables, a setup script and a cache. A cloud session runs in one Environment, and Project threads use the Environment chosen in Project settings. A Project picks its repositories separately ([research](../research.md#claude-cloud-environments), [Claude Projects](https://code.claude.com/docs/en/claude-projects)).

## Decision

### Concept map

The Session is where the other concepts meet. Each one answers a single question about a Session:

| Concept     | Question                                 | A Session has                     |
| ----------- | ---------------------------------------- | --------------------------------- |
| Project     | Which goal is this part of?              | at most one, with a role          |
| Repository  | Which code?                              | zero or more                      |
| Environment | Where does it run, and under what rules? | exactly one, fixed when it starts |
| Profile     | Which Pi: packages, extensions, skills?  | exactly one, fixed when it starts |

- Project, Repository, Environment and Profile are peers. None of them contains another.
- A Project has a default Environment but doesn't own it. One Environment serves many Projects, and one Project's Sessions can run in different Environments.
- A Project never owns infrastructure, which is what [vision.md](../vision.md#projects-are-logical-not-infrastructure-boundaries) already says.
- Under an Environment is infrastructure the user doesn't pick: a Runtime Provider supplies a Runtime, and the Runtime realizes the Session's Workspace.
- A Repository is identified by its clone URL. v1 stores URLs where they are used and has no repositories table. A table can come when something hangs off a repository, such as credentials or a mirror setting.
- Profiles stay in v2. A v1 Session uses its provider's own Pi setup ([ADR 0005](0005-v1-access-and-model-credentials.md)). v2 Profiles are in [ADR 0031](0031-profiles.md).

### Environments in v1

- An Environment has an id, a name and exactly one provider.
- The server creates an Environment named after a provider the first time that provider polls. That is the only way to get one in v1.
- A Session stores its `environmentId` when it is created and keeps it. The provider is read from the Environment.
- Existing Sessions are migrated to the Environment of their provider.
- The API and UI take an Environment where they took a provider. The provider still shows next to it, along with its online state.
- Running a Session somewhere else means starting a new Session in another Environment. [ADR 0006](0006-provider-protocol.md) still pins a Session to its provider.
- Picking an Environment follows the order in [concepts.md](../concepts.md#environment-selection): an explicit choice on the Session, then the Project's default, then the first Environment.

## Consequences

- In v1 an Environment is close to a label for a provider. It costs a table, a column and a migration.
- v2 adds setup, variables, network policy, revisions and provider pools to the same record. Projects, Sessions and the API don't change shape.
- Whether a coordinator and its threads get different default Environments stays open until there is a need.
- Renaming or deleting Environments, and creating them by hand, wait until Environments have settings worth editing.
