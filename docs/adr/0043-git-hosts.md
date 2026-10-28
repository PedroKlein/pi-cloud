# 0043: Git Hosts

- Status: accepted
- Date: 2026-10-28

## Context

A runner signs git in only one way: an Environment secret named `GH_TOKEN` becomes a git credential helper for `https://github.com` ([ADR 0034](0034-v2-deployment-and-credentials.md#git-credentials)). That leaves three gaps.

- Profile packages install with no credentials at all. The runner installs them while it syncs the Profile ([ADR 0041](0041-profiles-as-folders.md#on-the-runner)), before it sets up anything from the Environment, so Pi's `git clone` of a private package fails with code 128.
- Only github.com is covered. A repository on a GitHub Enterprise host, such as `github.tools.sap`, can't be cloned for a workspace or pushed to, and `gh` doesn't know the host.
- The token belongs to the Environment, so every person using it acts as the same GitHub account.

Claude Code handles GitHub Enterprise by having an admin connect each host once. Sessions then clone, push and install plugin marketplaces with that host's credentials, and people use `gh auth login --hostname` where the GitHub MCP server doesn't support the host ([GitHub Enterprise Server](https://code.claude.com/docs/en/github-enterprise-server)).

## Decision

### A `git-hosts` plugin

- Git hosts are a first-party plugin, `git-hosts`, not part of the kernel or of Environments (decided 2026-10-28).
- Connections are per person. Each person signs in to each host with their own account, and Sessions act as that account (decided 2026-10-28).

### Hosts in the config file

- An admin lists the hosts in the plugin's key of `pipoca.json` ([ADR 0039](0039-plugin-config-files.md)). Each entry has a `host`, a `label`, and optionally an OAuth app and a CA certificate for a host with a private certificate authority. The API address defaults to `https://api.github.com` for github.com and `https://<host>/api/v3` for others.
- An OAuth app's secret is sealed when Settings saves it, or named by `clientSecretEnv`, as the `oidc` plugin does.
- With no hosts in the file, the plugin lists github.com alone, so a fresh install works without config.
- Admins add, change and remove hosts in Settings, which edits the file.

```json
{
  "git-hosts": {
    "hosts": [
      { "host": "github.com", "label": "GitHub" },
      {
        "host": "github.tools.sap",
        "label": "SAP GitHub",
        "oauth": {
          "clientId": "Iv1.abc",
          "clientSecretEnv": "SAP_GITHUB_SECRET"
        }
      }
    ]
  }
}
```

### Connecting an account

- A host with an OAuth app shows a Connect button. It opens the host's sign-in and comes back to `/api/plugins/git-hosts/callback`. A host without one asks for a personal access token instead (decided 2026-10-28).
- The plugin checks the token against the host's API once and keeps the account's login next to it.
- A connection is state the product creates as it runs, so it lives in the plugin's SQLite store, sealed with the server's secret key. The web only ever sees the host, the login and when the connection was made.
- People see and remove their connections in Settings.

### On the runner

- The server sends the connections of the person who owns the Session with each assignment, as it sends Environment secrets. The agent can read them, as ADR 0034 already says of `GH_TOKEN`.
- The runner sets up one git credential helper per connected host, the way `GH_TOKEN` works today, and writes a `gh` config with every connected host into a folder only that Session uses. Workspace clones, the Session's pushes and its `gh` commands all use them.
- Profile packages install with the same credentials: those of the person whose Session starts (decided 2026-10-28). The runner keeps installing each package once per Profile and machine, so later Sessions with that Profile reuse it whoever starts them. A package on a host the person hasn't connected fails the Session with an error that names the host and says to connect it.
- A person's connection wins for its host. An Environment's `GH_TOKEN` still signs github.com in for people who haven't connected github.com, so existing setups keep working (decided 2026-10-28).

### Picking a repository

- The plugin adds a source to New Session's existing "Folder or repository" picker. It doesn't add a new step (decided 2026-10-28).
- Recent repositories come first. Typing searches the repositories the person can reach on every connected host, through each host's API, and results are grouped by host. A host chip narrows the search to one host, and `owner/repo` resolves to the first host in the list.

### Later

- A GitHub App per host, with short-lived tokens that refresh, can be added as a third way to connect, with brokered secrets.
- MCP servers in a Profile, such as GitHub's, don't get connections in this ADR. `gh` is the supported way to reach a host's API from a Session.
- GitLab and other forges can be added to the plugin later. Only GitHub and GitHub Enterprise are covered now.

## Consequences

- A Profile, workspace or push can use a private repository on any listed host, with the person's own account.
- Every person who starts Sessions needs a connection for the hosts their Profiles and repositories live on, or the Environment's `GH_TOKEN` for github.com.
- A package cached on a runner reaches later Sessions with that Profile, even for people who can't read its repository. Adding a package to a shared Profile already shares it.
- A token can still be read and leaked by the agent, as with Environment secrets today.
- Pipoca can only reach hosts its runners can reach. A host on a private network needs runners inside that network.
- ADR 0034's `GH_TOKEN` stays as a fallback. The rest of ADR 0034 stands.
