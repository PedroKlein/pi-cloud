# 0024: Provider login from the web

- Status: accepted
- Date: 2026-10-22

## Context

A Session can only use models whose provider is logged in on its machine ([ADR 0005](0005-v1-access-and-model-credentials.md)). Today that means opening a terminal on the laptop or the VM and running Pi's `/login` there. The model aliases ([ADR 0019](0019-model-aliases.md)) are one way to pick models, not the only one: a user should be able to log in to a provider and pick any of its models from the web, like Claude Code's `/login` and model picker.

Pi's login is already interactive through callbacks. `ModelRuntime.login(provider, type, interaction)` runs an API key or OAuth flow and asks for everything through `interaction.prompt` (`text`, `secret`, `select` or `manual_code`) and `interaction.notify` (`info`, `auth_url`, `device_code` or `progress`). Pi stores the credential in the machine's Pi auth file, the same one its TUI uses. The Session host already relays prompts to the browser for extensions ([ADR 0006](0006-provider-protocol.md)).

## Decision

### Login runs in a Session, on its machine

- `/login [provider]` and `/logout [provider]` join the built-in commands ([ADR 0023](0023-session-settings-and-pi-commands.md#pis-built-in-commands)). The Session host runs them with Pi's `login` and `logout` on the Session's model runtime.
- Without a provider, `/login` asks which one, listing Pi's providers and marking the ones already logged in. A provider with both an API key and OAuth asks which to use.
- Pi writes the credential to the machine's Pi auth file, as `pi` would there. Every Session in that Environment can use it. Another Environment needs its own login.
- The composer's model menu ends with "Log in to a provider…", which sends `/login`.

### The flow in the browser

| Pi asks or tells   | The browser shows                                                        |
| ------------------ | ------------------------------------------------------------------------ |
| `text`             | An input prompt.                                                         |
| `secret`           | A new `secret` prompt: a password field.                                 |
| `select`           | A select prompt.                                                         |
| `manual_code`      | An input prompt asking for the code, or the URL the login redirected to. |
| `auth_url`         | A note with the link, which opens in a new tab.                          |
| `device_code`      | A note with the code and the verification link.                          |
| `info`, `progress` | A note.                                                                  |

- OAuth flows that redirect to a callback on `localhost` work when the browser runs on the same machine. On the VM the redirect fails in the user's browser, so they paste its URL into the `manual_code` prompt that Pi races against the callback.
- Cancelling a prompt cancels the login.

### Credentials pass through, they aren't kept

ADR 0005 is amended: a key or code typed in the browser passes through the Control Plane on its way to the machine. The Control Plane never stores it, and it isn't written to the transcript, the live surfaces or any log. Only the machine's Pi auth file keeps it.

### Models follow the login

- The `settings` surface gains `models`, the models the Session's runtime has credentials for. The composer's model menu lists the Environment's aliases, then these. After a login or logout, the host sends `settings` again, so new models show up without a restart.
- The provider lists its machine's models again every minute, so the New session form follows too.

### Not now

- Logging in from an Environment's page without a Session. That needs the provider itself to run the flow, which the protocol can't relay yet.
- Moving one login to other machines. That belongs with Profiles in v2.

## Consequences

- A user can add a provider and switch to its models from the web, on the laptop or the VM, without a terminal.
- Anyone who can reach the Control Plane can log the machine in or out of a provider. That matches v1's localhost-only access (ADR 0005) and has to change with authentication.
- OAuth on a remote machine takes one extra paste.
