# 0036: Plugin Settings and Load Failures

- Status: accepted
- Date: 2026-10-25

## Context

[ADR 0022](0022-plugin-model-v2.md) decided that plugins get a manifest and settings with a schema, and left both to be built when v2 needs them. Neither exists yet. Plugins that need configuration hard-code it, such as the Library's 10 MB file limit, or read the server's environment, such as the Kubernetes plugin's runner image. Two plugins, Kubernetes and Models, keep their own settings per Environment and draw their own forms for them on the Environments page.

Two other gaps showed up while reviewing how [Hermes Agent](https://github.com/NousResearch/hermes-agent) and [OpenClaw](https://github.com/openclaw/openclaw) model their plugins:

- A plugin whose `register` throws stops the whole server. Hermes and OpenClaw both catch a failed load, undo what the plugin registered so far, and show the error in their plugin list.
- Nothing says which changes to the plugin interface third-party plugins can survive. Hermes keeps old plugins working by only adding things; OpenClaw versions its plugin API.

Both projects declare a plugin's settings in its manifest, so the host can draw the form and validate values without running the plugin's code. Hermes renders `config_schema` as a form in its desktop app.

## Decision

### The manifest, for built-in plugins first

- Every built-in plugin's `package.json` gets the `piCloud` field from ADR 0022, with `id`, `title`, `description` and `settings`. The app imports each built-in's `package.json`, so the manifest is where the server learns what plugins exist, even when a plugin's code fails.
- `version`, `engine`, `parts`, `capabilities` and `requires` are added when third-party install is built. ADR 0022 is unchanged for them.

### Settings

- A plugin declares each setting by name, with a `type`, a `title`, an optional `description` and a `default`. The types are ADR 0022's: `string`, `number` (with optional `min` and `max`), `boolean`, `choice` (one of `options`), and `strings` (a list of strings).
- Every setting has a default, so a plugin never sees a missing value.
- Values are stored once for the installation, in the kernel's database. A save sends the whole set and is checked against the schema; an invalid value is refused with a message that names the setting.
- A stored value that no longer fits the schema, after a plugin changes it, reads as the default. Names the schema no longer has are dropped on the next save.
- The server part reads its values with `ctx.settings.get()`, fresh on every call, so a change applies to the server part at once. The Session part gets `cloud.settings`, the values when the Session started. The web part reads `context.settings`, the values when the page loaded. Every web slot already gets the context, so this replaces ADR 0022's props.
- There is no secret type yet. It comes with the first plugin that needs one. Its values will be sealed with the server's secret key like Environment secrets ([ADR 0034](0034-v2-deployment-and-credentials.md)), never sent to the web, and sent to a Session part only when the setting asks for it.
- Settings that belong to an Environment, like the Kubernetes plugin's, stay in the plugin's own Environment section. Plugin settings are for the whole installation.

### The Plugins page

- A Plugins page, next to Profiles and Environments, lists every plugin with its title, description and state: on, off, or failed with its error. Each plugin that has settings gets a form drawn from its schema, with the same fields as the Environments page.
- Turning plugins on and off from this page comes with third-party install, together with the restart ADR 0022 describes. Until then a plugin is turned off with the server's `disabledPlugins` option.

### A plugin that fails to start

- The host keeps what a plugin registers (tools, routes, model offers, event subscriptions) aside until its `register` returns. If `register` throws, the host drops them, aborts the plugin's `signal`, logs the error and carries on with the other plugins.
- A failed plugin is off for the rest of the run. Its web part isn't loaded, and Sessions that start later don't get its Session part. The Plugins page shows the error.
- Anything the plugin did outside the host, such as Sessions it started or tables it created, stays.

### Compatibility

These rules hold while the plugin interface keeps its engine version:

- The kernel only adds: new optional members on `ctx` and `cloud`, new optional props on slots, new slots, new event types and new fields on events.
- Plugins ignore event types and fields they don't know. The kernel ignores manifest fields it doesn't know.
- Removing or changing the meaning of anything a plugin can reach needs a new engine version, and the kernel keeps serving the old one for a while.
- A plugin can add a setting with a default at any time. Changing a setting's type or removing it is safe too, because old values fall back to the default.

### Later

These ideas from the review are written down in [v2-ideas.md](../v2-ideas.md#extensions) and wait for a plugin that needs them: plugins that extend each other through declared contribution points, typed hooks with per-plugin grants, operations defined once and served as a route, a tool and a command, inline views drawn from tool results, declared backups and migrations, and a separate process for untrusted server parts.

## Consequences

- Plugin authors get settings with a form, validation and defaults without writing UI.
- A broken plugin no longer stops the server, and the user sees why it is off.
- The built-in plugins' `package.json` files become part of the plugin interface.
- The web needs a reload to see changed settings, and a Session a restart. Server parts see them at once.
- Third-party plugins can count on additive changes only, which keeps old names around until an engine version change.
