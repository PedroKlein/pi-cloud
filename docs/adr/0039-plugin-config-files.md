# 0039: Plugin Config Files

- Status: accepted
- Date: 2026-10-26

## Context

Everything a plugin keeps lives in the server's SQLite database. Plugin settings are stored there ([ADR 0036](0036-plugin-settings.md)), and the `oidc` plugin keeps its providers in its own table, edited only in Settings ([ADR 0038](0038-single-sign-on-and-admins.md)). A fresh install on Kyma can't come up with its identity providers already set. Someone has to sign in with the setup link and type them in, and the setup can't live in Git next to the Helm values.

Pi doesn't give extensions a settings API. It gives them a known folder, `~/.pi/agent`, and each extension decides how to keep its settings. Some keep their own file there, such as `web-search.json` or `mcp.json`. Others put a key of their own in Pi's `settings.json`, as pi-subagents does with `subagents`. Pi's docs tell an extension to register its MCP servers again on every load "based on the extension's own settings".

Claude Code reads managed settings from a file (`managed-settings.json`) that wins over user and project settings ([settings precedence](https://code.claude.com/docs/en/settings#settings-precedence)), so an admin can set them up once without a UI.

## Decision

### A config folder

- The server reads plugin config from a folder, set with `--config-dir`. It defaults to `~/.pi-cloud/config`, next to the database.
- The folder can hold a shared `pi-cloud.json`, an object with one key per plugin id, like Pi's `settings.json`. It can also hold a folder per plugin, named for its id, for files the plugin keeps on its own.
- Both are optional. A missing file or folder is the same as an empty one.
- The Helm chart takes a `config` value, renders it into a ConfigMap and mounts it read-only as the folder. A change to it restarts the pod.

### What a plugin gets

- `ctx.config.value` is the plugin's own key from `pi-cloud.json`, or undefined. The plugin validates it. The kernel only parses the JSON, and a file that doesn't parse stops the server with the error, since every plugin would read it wrong.
- `ctx.config.dir` is the path of the plugin's own folder. The plugin reads and writes its files there, in whatever format it wants.
- Both are read when the server starts. A change needs a restart, like a plugin install ([ADR 0022](0022-plugin-model-v2.md)).
- A plugin sees only its own key. Its folder isn't enforced, since server parts run in the server's process ([ADR 0022](0022-plugin-model-v2.md#trust)), so it is a convention, as it is in Pi.
- `ctx.store` and `ctx.settings` stay. A plugin can use a file, SQLite or both.

### Choosing between a file and SQLite

- A file is for what an admin sets up once and wants in Git: identity providers, limits, runner images.
- SQLite is for what the product creates while it runs (users, linked identities, Sessions) and for settings people change in the UI.
- When a plugin reads the same thing from both, the file wins, and its web part shows those entries as set by the config and doesn't let people edit them.
- The folder may be read-only, as it is on Kyma, so a plugin must work without writing to it. A plugin that edits its config in the UI can offer an export of it as JSON to put in the file.

### Secrets

- Secrets don't go in the file, which ends up in Git and in a ConfigMap. A config entry names an environment variable instead, such as `clientSecretEnv`, and the plugin reads that variable.
- The Helm chart takes `extraEnvFrom`, so those variables can come from Kubernetes Secrets.

### OIDC first

- The `oidc` plugin reads `providers` from its key, each with the fields Settings has today, and `clientSecretEnv` in place of the client secret.
- Providers from the file sign people in like those added in Settings. Settings lists them as set by the config, and can't change or remove them. A provider in the file wins over one in the table with the same id.

```json
{
  "oidc": {
    "providers": [
      {
        "id": "ias",
        "label": "SAP",
        "issuer": "https://example.accounts.ondemand.com",
        "clientId": "pi-cloud",
        "accessGroup": "pi-cloud-users",
        "adminGroup": "pi-cloud-admins"
      }
    ]
  }
}
```

### Later

- ADR 0036's declared settings could also be set from `pi-cloud.json`, and the server's own options too. This waits until someone needs it.
- Reading the folder again without a restart waits for a plugin that needs it.

## Consequences

- An install can come up fully set up from its Helm values, with no clicks after the setup link.
- Plugin authors choose where their config lives, as Pi extension authors do, and the kernel only provides the place.
- Config in a file needs a restart to change. Config in SQLite still changes at once.
- A plugin that reads both has to merge them and show which entries come from the file.
- Secrets reach plugins through environment variables, so the chart and the VM setup need a way to set them.
