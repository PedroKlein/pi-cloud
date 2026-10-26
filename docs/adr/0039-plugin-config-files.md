# 0039: Plugin Config Files

- Status: accepted
- Date: 2026-10-26

## Context

Everything a plugin keeps lives in the server's SQLite database. Plugin settings are stored there ([ADR 0036](0036-plugin-settings.md)), and the `oidc` plugin keeps its providers in its own table, edited only in Settings ([ADR 0038](0038-single-sign-on-and-admins.md)). A fresh install on Kyma can't come up with its identity providers already set. Someone has to sign in with the setup link and type them in, and the setup can't live in Git next to the Helm values.

Pi doesn't give extensions a settings API. It gives them a known folder, `~/.pi/agent`, and each extension decides how to keep its settings. Some keep their own file there, such as `web-search.json` or `mcp.json`. Others put a key of their own in Pi's `settings.json`, as pi-subagents does with `subagents`. Pi's docs tell an extension to register its MCP servers again on every load "based on the extension's own settings". People edit these files by hand, and Pi's own `/settings` command writes to the same `settings.json`.

Claude Code reads managed settings from a file (`managed-settings.json`) that wins over user and project settings ([settings precedence](https://code.claude.com/docs/en/settings#settings-precedence)), so an admin can set them up once without a UI.

## Decision

### A config folder

- The server keeps plugin config in a folder, set with `--config-dir`. It defaults to `~/.pi-cloud/config`, next to the database.
- The folder can hold a shared `pi-cloud.json`, an object with one key per plugin id, like Pi's `settings.json`. It can also hold a folder per plugin, named for its id, for files the plugin keeps on its own.
- Both are optional. A missing file or folder is the same as an empty one.
- The folder is writable. People edit it by hand, and the UI edits it too, as Pi's `/settings` edits `settings.json` (decided 2026-10-26).

### What a plugin gets

- `ctx.config.get()` returns the plugin's own key from `pi-cloud.json`, or undefined. The kernel reads the file again when it changed on disk, so edits by hand apply without a restart. The plugin validates what it gets. A file that doesn't parse is logged, and every plugin keeps the last value that did. Writes are refused until the file is fixed, so a slip by hand isn't overwritten.
- `ctx.config.set(value)` replaces the plugin's own key and leaves the other keys alone. The kernel writes the whole file to a temporary file and renames it over the old one, one write at a time, so a crash never leaves half a file. It writes JSON with two-space indents, so formatting added by hand isn't kept.
- `ctx.config.dir` is the path of the plugin's own folder. The plugin reads and writes its files there, in whatever format it wants.
- A plugin sees only its own key. Its folder isn't enforced, since server parts run in the server's process ([ADR 0022](0022-plugin-model-v2.md#trust)), so it is a convention, as it is in Pi.
- `ctx.store` and `ctx.settings` stay. A plugin can use a file, SQLite or both. Not everything belongs in SQLite, and SQLite still fits some things (decided 2026-10-26).

### Choosing between a file and SQLite

- A file is for config people may want to set up ahead of time, read, copy or keep in Git: identity providers, limits, runner images. The UI edits it in place.
- SQLite is for what the product creates while it runs, such as users, linked identities and Sessions, and for data too big or too busy for a JSON file.

### Secrets

- A secret the UI saves goes into the file sealed with the server's secret key, the way plugin stores seal values today ([ADR 0038](0038-single-sign-on-and-admins.md)). The plugin seals it with `ctx.store.seal`, for a context such as the provider's id, and only that plugin can open it. A sealed value is useless without the key, which stays in a Kubernetes Secret or the VM's key file ([ADR 0034](0034-v2-deployment-and-credentials.md)).
- A config entry can instead name an environment variable, such as `clientSecretEnv`, for a secret set up outside Pi Cloud. Hand-written config in Git uses this. The plugin reads the variable once and removes it from the server's environment, so the Sessions the server starts don't inherit it.
- The Helm chart takes `extraEnvFrom`, so those variables can come from Kubernetes Secrets.

### Helm

- The folder lives on the server's data volume, at `/data/config`, so UI edits survive restarts and upgrades.
- The chart takes a `config` value. An init container writes it as `pi-cloud.json` only when the file doesn't exist yet. After that the file on the volume is the source of truth, and the UI and people editing it by hand change it there.
- To push a change from Git over UI edits, an admin deletes the file and restarts, or edits it directly. Merging Helm values into a file the UI has changed is left out: two writers with no clear winner would surprise people.

### OIDC first

- The `oidc` plugin keeps its providers in `pi-cloud.json` under its key instead of its table. Settings adds, changes and removes them through `ctx.config.set`.
- On its first start with this change, the plugin moves the providers in its table to the file, client secrets still sealed, and drops the table. Linked identities stay in SQLite.
- A provider's secret is either sealed in `clientSecret`, as Settings saves it, or named by `clientSecretEnv`.
- Settings makes a readable id from the label, such as `sap` for "Sign in with SAP", and writes only the fields that aren't empty or default.
- A provider list that doesn't fit when the server starts makes the plugin fail, with the reason on the Plugins page. One that stops fitting later is logged, and the last list that fit stays in use.

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

- ADR 0036's declared settings could move to `pi-cloud.json` too, and the server's own options with them. This waits until someone needs it.

## Consequences

- An install can come up fully set up from its Helm values, with no clicks after the setup link.
- Plugin authors choose where their config lives, as Pi extension authors do, and the kernel only provides the place, the reads and the safe writes.
- Config can be read and edited by hand on the server, and the UI keeps working on the same file.
- After the first start, Helm's `config` value no longer changes anything by itself. Git stops being the source of truth for config the UI can edit.
- Sealed secrets in the file only work with the same server secret key, so copying the file to another install needs the key too, or env-named secrets.
