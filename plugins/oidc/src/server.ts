import { createHash, randomBytes } from "node:crypto";
import type { PluginStore, ServerPlugin, User } from "@pi-cloud/plugins";
import type { PluginSettings } from "@pi-cloud/protocol";
import type { LinkedIdentity } from "./identity";
import {
  type Attempt,
  authorizationUrl,
  type Client,
  discover,
  type Identity,
  LoginFailed,
  newAttempt,
  type Provider,
  redeem,
} from "./oidc";

// Taken out of the environment as the binary starts, since the built-in
// runner's Sessions inherit it.
const clientSecret = process.env["PI_CLOUD_OIDC_CLIENT_SECRET"];
delete process.env["PI_CLOUD_OIDC_CLIENT_SECRET"];

// A browser has this long to come back from the provider.
const attemptMs = 10 * 60_000;
const browserCookie = "pi-cloud-oidc";

interface Pending extends Attempt {
  readonly browser: string;
  // Set when a signed-in user links their identity.
  readonly linkTo: string | undefined;
  readonly expires: number;
}

interface Settings {
  readonly issuer: string;
  readonly clientId: string;
  readonly label: string;
  readonly groupsClaim: string;
  readonly accessGroup: string;
  readonly adminGroup: string;
  // Lower case. Each lets people in by their verified email, for a provider
  // that sends no groups, such as Google.
  readonly allowedEmails: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly adminEmails: readonly string[];
}

export const oidc: ServerPlugin = {
  name: "oidc",
  register: (context) => {
    const identities = identityStore(context.store);
    const pending = new Map<string, Pending>();
    const providers = new Map<string, Promise<Provider>>();

    const configured = (): Settings | undefined => {
      const settings = settingsOf(context.settings.get());

      return settings.issuer === "" || settings.clientId === ""
        ? undefined
        : settings;
    };

    const provider = async (issuer: string): Promise<Provider> => {
      const found = providers.get(issuer) ?? discover(issuer);
      providers.set(issuer, found);

      // A failed discovery is tried again on the next sign-in.
      return found.catch((error: unknown) => {
        providers.delete(issuer);
        throw error;
      });
    };

    const client = (settings: Settings): Client => ({
      id: settings.clientId,
      secret: clientSecret === "" ? undefined : clientSecret,
    });

    const start = async (
      request: Request,
      linkTo: string | undefined,
    ): Promise<Response> => {
      const settings = configured();
      if (settings === undefined) {
        return page("Single sign-on isn't set up on this server.", 404);
      }

      const now = Date.now();
      for (const [state, each] of pending) {
        if (each.expires < now) {
          pending.delete(state);
        }
      }

      const attempt = newAttempt();
      const browser = randomBytes(32).toString("base64url");

      pending.set(attempt.state, {
        ...attempt,
        browser: hash(browser),
        linkTo,
        expires: now + attemptMs,
      });

      return new Response(null, {
        status: 302,
        headers: {
          location: authorizationUrl(
            await provider(settings.issuer),
            client(settings),
            redirectUri(request),
            attempt,
          ),
          // Lax, since the provider's redirect back is a cross-site
          // navigation, which leaves Strict cookies out.
          "set-cookie": new Bun.Cookie(browserCookie, browser, {
            path: "/api/plugins/oidc/",
            httpOnly: true,
            sameSite: "lax",
            secure: secure(request),
            maxAge: attemptMs / 1000,
          }).serialize(),
        },
      });
    };

    const callback = async (request: Request): Promise<Response> => {
      const settings = configured();
      const params = new URL(request.url).searchParams;
      const attempt = pending.get(params.get("state") ?? "");

      const browser = new Bun.CookieMap(
        request.headers.get("cookie") ?? "",
      ).get(browserCookie);

      // The state must come back to the browser that left with it, so a
      // link can't sign someone in as another person (RFC 6749, 10.12).
      if (
        settings === undefined ||
        attempt === undefined ||
        attempt.expires < Date.now() ||
        browser === null ||
        hash(browser) !== attempt.browser
      ) {
        return page("This sign-in has expired. Start it again.", 400);
      }

      pending.delete(attempt.state);

      const error = params.get("error");
      if (error !== null) {
        context.log("sign-in refused by the provider", { error });

        return page(
          `The identity provider refused the sign-in: ${params.get("error_description") ?? error}`,
          403,
        );
      }

      try {
        const identity = await redeem(
          await provider(settings.issuer),
          client(settings),
          redirectUri(request),
          attempt,
          params.get("code") ?? "",
        );

        return signIn(request, settings, identity, attempt.linkTo);
      } catch (failure) {
        if (!(failure instanceof LoginFailed)) {
          throw failure;
        }

        context.log("sign-in failed", { error: failure.message });

        return page(`Sign-in failed: ${failure.message}`, 502);
      }
    };

    const signIn = (
      request: Request,
      settings: Settings,
      identity: Identity,
      linkTo: string | undefined,
    ): Response => {
      const fields = { subject: identity.subject, email: identity.email };

      const { allowed, admin } = access(settings, identity);

      if (!allowed) {
        context.log("sign-in refused: not let in", fields);

        return page(
          "This server doesn't let your account in. Ask its admin to add you.",
          403,
        );
      }

      const linked = identities.find(identity);

      if (linkTo !== undefined) {
        if (linked !== undefined && linked.userId !== linkTo) {
          return page("This account already signs in as another user.", 409);
        }

        identities.link(identity, linkTo, false);
        context.log("identity linked", { ...fields, userId: linkTo });

        return redirect("/#settings", undefined);
      }

      let user: User | undefined;

      if (linked === undefined) {
        user = context.auth.createUser(
          identity.email ?? identity.subject,
          admin,
        );

        if (user === undefined) {
          return page(
            `A user named ${identity.email ?? identity.subject} already exists. Sign in with its password and link this account in Settings.`,
            409,
          );
        }

        identities.link(identity, user.id, true);
        context.log("user created", { ...fields, userId: user.id, admin });
      } else if (linked.created) {
        // Groups are read again on every sign-in, so a change in the
        // provider applies the next time.
        context.auth.setAdmin(linked.userId, admin);
      }

      const userId = user?.id ?? linked?.userId ?? "";
      const cookie = context.auth.startSession(userId, request);

      if (cookie === undefined) {
        return page("This account's user no longer exists.", 403);
      }

      context.log("signed in", { ...fields, userId });

      return redirect("/", cookie);
    };

    context.auth.offer(() => {
      const settings = configured();

      return settings && { label: settings.label, path: "start" };
    });

    context.auth.handlePublic(async (request, path) => {
      if (request.method !== "GET") {
        return undefined;
      }

      if (path === "start") {
        return start(request, undefined);
      }

      return path === "callback" ? callback(request) : undefined;
    });

    context.routes.handle(async (request, path) => {
      const user = context.auth.userOf(request);
      if (user === undefined) {
        return Response.json({ error: "signed_out" }, { status: 401 });
      }

      if (path === "link" && request.method === "GET") {
        return start(request, user.id);
      }

      if (path === "identities" && request.method === "GET") {
        return Response.json({
          configured: configured() !== undefined,
          identities: identities.of(user.id),
        });
      }

      if (path === "unlink" && request.method === "POST") {
        identities.unlink(user.id);
        context.log("identities unlinked", { userId: user.id });

        return Response.json({ identities: identities.of(user.id) });
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    });
  },
};

function settingsOf(values: PluginSettings): Settings {
  const text = (name: string): string => {
    const value = values[name];

    return typeof value === "string" ? value.trim() : "";
  };

  return {
    issuer: text("issuer"),
    clientId: text("clientId"),
    label: text("label") || "Sign in with single sign-on",
    groupsClaim: text("groupsClaim") || "groups",
    accessGroup: text("accessGroup"),
    adminGroup: text("adminGroup"),
    allowedEmails: texts(values, "allowedEmails"),
    allowedDomains: texts(values, "allowedDomains"),
    adminEmails: texts(values, "adminEmails"),
  };
}

function texts(values: PluginSettings, name: string): readonly string[] {
  const value = values[name];

  return Array.isArray(value)
    ? value.flatMap((each) =>
        typeof each === "string" && each.trim() !== ""
          ? [each.trim().toLowerCase()]
          : [],
      )
    : [];
}

// The groups come from the claim the provider puts them in. Emails count
// only once the provider has verified them.
function access(
  settings: Settings,
  identity: Identity,
): { readonly allowed: boolean; readonly admin: boolean } {
  const claim = identity.claims[settings.groupsClaim];

  const groups = (Array.isArray(claim) ? claim : [claim]).filter(
    (group): group is string => typeof group === "string" && group !== "",
  );

  const email = identity.emailVerified
    ? (identity.email?.toLowerCase() ?? "")
    : "";

  const domain = email.slice(email.lastIndexOf("@") + 1);

  const admin =
    groups.includes(settings.adminGroup) ||
    (email !== "" && settings.adminEmails.includes(email));

  return {
    admin,
    allowed:
      admin ||
      groups.includes(settings.accessGroup) ||
      (email !== "" &&
        (settings.allowedEmails.includes(email) ||
          settings.allowedDomains.includes(domain))),
  };
}

// The Host header already passed the server's own site check.
function redirectUri(request: Request): string {
  const host = request.headers.get("host") ?? new URL(request.url).host;

  return `${secure(request) ? "https" : "http"}://${host}/api/plugins/oidc/callback`;
}

// HTTPS usually ends in a gateway in front of the server (ADR 0034).
function secure(request: Request): boolean {
  return (
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https"
  );
}

// A page that moves on by itself instead of a 302: the browser came here
// from the provider's site, and would leave the new Strict cookie off a
// redirect it follows straight away.
function redirect(to: string, cookie: string | undefined): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${to}"><title>Pi Cloud</title><a href="${to}">Continue</a>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...(cookie !== undefined && { "set-cookie": cookie }),
      },
    },
  );
}

function page(message: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Pi Cloud</title><p>${escaped(message)}</p><p><a href="/">Back to Pi Cloud</a></p>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function escaped(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) => `&#${String(character.charCodeAt(0))};`,
  );
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface IdentityStore {
  readonly find: (
    identity: Identity,
  ) => { readonly userId: string; readonly created: boolean } | undefined;
  // created is true when the plugin made the user, so its groups decide
  // whether it is an admin.
  readonly link: (identity: Identity, userId: string, created: boolean) => void;
  readonly of: (userId: string) => readonly LinkedIdentity[];
  readonly unlink: (userId: string) => void;
}

function identityStore(store: PluginStore): IdentityStore {
  store.exec(`
    create table if not exists oidc_identities (
      issuer text not null,
      subject text not null,
      user_id text not null,
      email text,
      created integer not null,
      linked_at text not null,
      primary key (issuer, subject)
    )
  `);

  return {
    find: ({ issuer, subject }) => {
      const [row] = store.all(
        "select user_id, created from oidc_identities where issuer = ? and subject = ?",
        issuer,
        subject,
      ) as { user_id: string; created: number }[];

      return row && { userId: row.user_id, created: row.created === 1 };
    },
    link: ({ issuer, subject, email }, userId, created) => {
      store.run(
        "insert into oidc_identities (issuer, subject, user_id, email, created, linked_at) values (?, ?, ?, ?, ?, ?) on conflict (issuer, subject) do update set email = excluded.email",
        issuer,
        subject,
        userId,
        email,
        created ? 1 : 0,
        new Date().toISOString(),
      );
    },
    of: (userId) =>
      (
        store.all(
          "select email, linked_at, created from oidc_identities where user_id = ? order by linked_at",
          userId,
        ) as { email: string | null; linked_at: string; created: number }[]
      ).map((row) => ({
        email: row.email,
        linkedAt: row.linked_at,
        created: row.created === 1,
      })),
    unlink: (userId) => {
      store.run(
        "delete from oidc_identities where user_id = ? and created = 0",
        userId,
      );
    },
  };
}
