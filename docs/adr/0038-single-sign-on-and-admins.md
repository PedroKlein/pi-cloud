# 0038: Single Sign-On and Admins

- Status: accepted, amended 2026-10-29 (plugin routes and meta-sessions act as the user who calls or starts them, never as an admin from a meta-session; admin-only shared config in plugins), what people see of others' Environments and Sessions replaced by [ADR 0049](0049-personal-environments-and-templates.md)
- Date: 2026-10-25

## Context

[ADR 0033](0033-v2-authentication-and-order.md) gives the kernel a password login and makes signing in through an OpenID Connect provider a first-party plugin. Pi Cloud on Kyma has no public host yet, and it gets one only once people sign in through a company identity provider with MFA. The first provider is an SAP Cloud Identity Services (IAS) tenant, which many people outside Pi Cloud also have accounts in.

The step 6 checkpoint decided that installing, updating, removing and turning on plugins becomes admin-only, together with OIDC ([ADR 0022](0022-plugin-model-v2.md#installing-third-party-plugins)). The kernel has no admins yet.

## Decision

### The `oidc` plugin

- A built-in plugin signs people in with the authorization code flow and PKCE. It works with any provider that publishes OpenID Connect discovery, and with several at once (decided 2026-10-26). Each gets its own button on the sign-in page.
- Admins add, change and remove providers in the plugin's section of Settings. Each provider has a label, an issuer, a client ID, an optional client secret, a groups claim, an access group, an admin group and lists of allowed emails, allowed domains and admin emails. They live in the plugin's own table rather than in plugin settings, which hold only flat fields.
- A client secret is only for providers that require one even with PKCE, such as Google. The plugin seals it with the server's secret key, like Environment secrets ([ADR 0034](0034-v2-deployment-and-credentials.md)), and never sends it back to the browser. Any plugin's store can seal values this way, and only that plugin can open them.
- Every provider shares one redirect URI, the server's own `/api/plugins/oidc/callback`, on whichever host the browser used. The sign-in's state says which provider it belongs to. The public host and a port-forward both work once both are registered with the provider.
- The ID token comes straight from the token endpoint over TLS, so the plugin checks its issuer, audience, expiry and nonce but not its signature ([OpenID Connect Core 1.0, 3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)). The issuer and token endpoint must be HTTPS, except on loopback for tests.
- A sign-in's state is bound to the browser that started it with a `SameSite=Lax` cookie, so a link to the callback can't sign someone in as another person.

### Who gets in

- Each provider has its own access rules. Access comes from the provider's groups, in the ID token. A member of the access group gets a Pi Cloud user on their first sign-in, keyed by issuer and subject, never by email. Anyone else is refused (decided 2026-10-25).
- A member of the admin group is an admin, and gets in too. The plugin reads the groups again on every sign-in, so a change in the provider applies at the next one.
- The groups come from the claim the settings name, `groups` by default, since providers differ.
- For a provider that sends no groups, such as Google, the email lists let people in by their email or its domain, and make admins by email. An email counts only when the token says `email_verified` (decided 2026-10-25). GitHub has no OpenID Connect sign-in, so it would need its own login plugin on the same seam, which waits until someone needs it.
- A password user, such as the first one from the setup link, can link their provider account from Settings and then sign in with it as themselves. Their admin flag stays their own.
- Users the plugin makes have no password.

### Admins

- The kernel's users get an admin flag. The setup link's user is an admin.
- Only admins install, update, remove or turn on plugins, change plugin settings and restart the server. Only admins change an Environment's Kubernetes settings too, since a pod patch can mount the namespace's Secrets or run a pod privileged (amended 2026-10-26). Only admins change an Environment's model aliases, since every user shares them. A Project's own settings, such as its goal, stay open to everyone (amended 2026-10-29). Everything else stays open to every signed-in user, since v2 has no per-user isolation ([vision.md](../vision.md#v3-a-teams-control-center)).

### The plugin seam

- A built-in plugin's server part gets `ctx.auth`: it offers a link on the sign-in page, answers some of its routes without a signed-in browser, makes users without a password, sets their admin flag and starts a browser session. Installed plugins don't get it, whatever capabilities they declare.
- A web part can draw a section on the Settings page.
- Every plugin route gets its caller: the user, also when a toolset tool acts for them, and whether they are an admin, or the plugin's own Session. A route acts as its caller, so a Session it starts for someone, such as a Project's coordinator, is theirs. `requireAdmin` in `@pipoca/plugins` answers 403 to anyone but an admin, for a route that changes config every user shares (amended 2026-10-29).

## Consequences

- Pi Cloud can sit behind a company identity provider, and MFA comes from the provider's own rules.
- Everyone in the access group sees every Session, Environment and secret until v3 brings roles and per-user ownership, so the group should hold only the people who would get the password. Replaced by [ADR 0049](0049-personal-environments-and-templates.md): people see their own Environments, runners and Sessions, and admins see everyone's as metadata only.
- The server's `--sso-only` flag (`oidc.ssoOnly` in the Helm chart) turns the password login off, for a public host. The setup link still works, so the first user can link their provider account from Settings.
- A sign-in started before a restart has to start again, since its state lives in memory.
- A meta-session's toolset tools act as the user who started it, but never as an admin, even when that user is one, so a meta-session still can't do anything that needs an admin. A Session a plugin route starts belongs to the user who called the route, and gets their git logins ([ADR 0043](0043-git-hosts.md)), also when a meta-session called it (amended 2026-10-29).
