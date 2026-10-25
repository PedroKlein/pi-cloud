# 0038: Single Sign-On and Admins

- Status: accepted
- Date: 2026-10-25

## Context

[ADR 0033](0033-v2-authentication-and-order.md) gives the kernel a password login and makes signing in through an OpenID Connect provider a first-party plugin. Pi Cloud on Kyma has no public host yet, and it gets one only once people sign in through a company identity provider with MFA. The first provider is an SAP Cloud Identity Services (IAS) tenant, which many people outside Pi Cloud also have accounts in.

The step 6 checkpoint decided that installing, updating, removing and turning on plugins becomes admin-only, together with OIDC ([ADR 0022](0022-plugin-model-v2.md#installing-third-party-plugins)). The kernel has no admins yet.

## Decision

### The `oidc` plugin

- A built-in plugin signs people in with the authorization code flow and PKCE. Its settings are the issuer, the client ID, the button's label, an access group and an admin group.
- A client secret, when the provider needs one, comes from `PI_CLOUD_OIDC_CLIENT_SECRET`. The binary takes it out of its environment as it starts, as it does `PI_CLOUD_SECRET_KEY`, since Sessions of the built-in runner inherit the environment. On Kubernetes it comes from a Secret the operator creates.
- The redirect URI is the server's own `/api/plugins/oidc/callback`, on whichever host the browser used, so the public host and a port-forward both work once both are registered with the provider.
- The ID token comes straight from the token endpoint over TLS, so the plugin checks its issuer, audience, expiry and nonce but not its signature ([OpenID Connect Core 1.0, 3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)). The issuer and token endpoint must be HTTPS, except on loopback for tests.
- A sign-in's state is bound to the browser that started it with a `SameSite=Lax` cookie, so a link to the callback can't sign someone in as another person.

### Who gets in

- Access comes from the provider's groups, in the ID token's `groups` claim. A member of the access group gets a Pi Cloud user on their first sign-in, keyed by issuer and subject, never by email. Anyone else is refused (decided 2026-10-25).
- A member of the admin group is an admin. The plugin reads the groups again on every sign-in, so a change in the provider applies at the next one.
- A password user, such as the first one from the setup link, can link their provider account from Settings and then sign in with it as themselves. Their admin flag stays their own.
- Users the plugin makes have no password.

### Admins

- The kernel's users get an admin flag. The setup link's user is an admin.
- Only admins install, update, remove or turn on plugins, change plugin settings and restart the server. Everything else stays open to every signed-in user, since v2 has no per-user isolation ([vision.md](../vision.md#v3-a-teams-control-center)).

### The plugin seam

- A built-in plugin's server part gets `ctx.auth`: it offers a link on the sign-in page, answers some of its routes without a signed-in browser, makes users without a password, sets their admin flag and starts a browser session. Installed plugins don't get it, whatever capabilities they declare.
- A web part can draw a section on the Settings page.

## Consequences

- Pi Cloud can sit behind a company identity provider, and MFA comes from the provider's own rules.
- Everyone in the access group sees every Session, Environment and secret until v3 brings roles and per-user ownership, so the group should hold only the people who would get the password.
- The password login stays on. Turning it off for a public host is its own change.
- A sign-in started before a restart has to start again, since its state lives in memory.
- Sessions still act as the installation's owner, not as the user who started them, so a meta-session can't do anything that needs an admin.
