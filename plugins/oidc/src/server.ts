import { createHash, randomBytes } from "node:crypto";
import type { PluginStore, ServerPlugin, User } from "@pipoca/plugins";
import type { Account, LinkedIdentity } from "./model";
import {
  type Attempt,
  type Client,
  authorizationUrl,
  discover,
  type Identity,
  LoginFailed,
  newAttempt,
  type Provider,
  redeem,
} from "./oidc";
import {
  InvalidProvider,
  type ProviderConfig,
  providerStore,
  viewOf,
} from "./providers";

// A browser has this long to come back from the provider.
const attemptMs = 10 * 60_000;
const browserCookie = "pipoca-oidc";

interface Pending extends Attempt {
  readonly providerId: string;
  readonly browser: string;
  // Set when a signed-in user links their identity.
  readonly linkTo: string | undefined;
  readonly expires: number;
}

export const oidc: ServerPlugin = {
  name: "oidc",
  register: (context) => {
    const identities = identityStore(context.store);

    const providers = providerStore(
      context.config,
      context.store,
      process.env,
      context.log,
    );

    const pending = new Map<string, Pending>();
    const discovered = new Map<string, Promise<Provider>>();

    const discovery = async (issuer: string): Promise<Provider> => {
      const found = discovered.get(issuer) ?? discover(issuer);
      discovered.set(issuer, found);

      // A failed discovery is tried again on the next sign-in.
      return found.catch((error: unknown) => {
        discovered.delete(issuer);
        throw error;
      });
    };

    const client = (config: ProviderConfig): Client => ({
      id: config.clientId,
      secret: config.clientSecret,
    });

    const start = async (
      request: Request,
      providerId: string,
      linkTo: string | undefined,
    ): Promise<Response> => {
      const config = providers.get(providerId);
      if (config === undefined) {
        return page("This server has no such sign-in.", 404);
      }

      const now = Date.now();
      for (const [state, each] of pending) {
        if (each.expires < now) {
          pending.delete(state);
        }
      }

      const attempt = newAttempt();
      const browser = randomBytes(32).toString("base64url");

      let location: string;
      try {
        location = authorizationUrl(
          await discovery(config.issuer),
          client(config),
          redirectUri(request),
          attempt,
        );
      } catch (failure) {
        if (!(failure instanceof LoginFailed)) {
          throw failure;
        }

        context.log("discovery failed", {
          provider: config.id,
          error: failure.message,
        });

        return page(`Sign-in failed: ${failure.message}`, 502);
      }

      pending.set(attempt.state, {
        ...attempt,
        providerId,
        browser: hash(browser),
        linkTo,
        expires: now + attemptMs,
      });

      return new Response(null, {
        status: 302,
        headers: {
          location,
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
      const params = new URL(request.url).searchParams;
      const attempt = pending.get(params.get("state") ?? "");
      const config = attempt && providers.get(attempt.providerId);

      const browser = new Bun.CookieMap(
        request.headers.get("cookie") ?? "",
      ).get(browserCookie);

      // The state must come back to the browser that left with it, so a
      // link can't sign someone in as another person (RFC 6749, 10.12).
      if (
        attempt === undefined ||
        config === undefined ||
        attempt.expires < Date.now() ||
        browser === null ||
        hash(browser) !== attempt.browser
      ) {
        return page("This sign-in has expired. Start it again.", 400);
      }

      pending.delete(attempt.state);

      const error = params.get("error");
      if (error !== null) {
        context.log("sign-in refused by the provider", {
          provider: config.id,
          error,
        });

        return page(
          `The identity provider refused the sign-in: ${params.get("error_description") ?? error}`,
          403,
        );
      }

      try {
        const identity = await redeem(
          await discovery(config.issuer),
          client(config),
          redirectUri(request),
          attempt,
          params.get("code") ?? "",
        );

        return signIn(request, config, identity, attempt.linkTo);
      } catch (failure) {
        if (!(failure instanceof LoginFailed)) {
          throw failure;
        }

        context.log("sign-in failed", {
          provider: config.id,
          error: failure.message,
        });

        return page(`Sign-in failed: ${failure.message}`, 502);
      }
    };

    const signIn = (
      request: Request,
      config: ProviderConfig,
      identity: Identity,
      linkTo: string | undefined,
    ): Response => {
      const fields = {
        provider: config.id,
        subject: identity.subject,
        email: identity.email,
      };

      const { allowed, admin } = access(config, identity);

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

        return redirect("/#settings/oidc", undefined);
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

    // Admins add, change and remove providers.
    const manage = async (
      request: Request,
      path: readonly string[],
    ): Promise<Response> => {
      const [, id] = path;

      try {
        if (id === undefined && request.method === "GET") {
          return Response.json(providers.list().map(viewOf));
        }

        if (id === undefined && request.method === "POST") {
          const created = providers.create(await request.json());
          context.log("provider added", { provider: created.id });

          return Response.json(viewOf(created), { status: 201 });
        }

        if (id !== undefined && path[2] === "remove") {
          return providers.remove(id)
            ? Response.json({ removed: id })
            : Response.json({ error: "not_found" }, { status: 404 });
        }

        if (id !== undefined && request.method === "POST") {
          const updated = providers.update(id, await request.json());

          return updated === undefined
            ? Response.json({ error: "not_found" }, { status: 404 })
            : Response.json(viewOf(updated));
        }
      } catch (failure) {
        if (
          failure instanceof InvalidProvider ||
          failure instanceof SyntaxError
        ) {
          return Response.json({ error: failure.message }, { status: 400 });
        }

        throw failure;
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    };

    context.auth.offer(() =>
      providers.list().map(({ id, label }) => ({ label, path: `start/${id}` })),
    );

    context.auth.handlePublic(async (request, path) => {
      if (request.method !== "GET") {
        return undefined;
      }

      const [route, id] = path.split("/");

      if (route === "start" && id !== undefined) {
        return start(request, id, undefined);
      }

      return route === "callback" ? callback(request) : undefined;
    });

    context.routes.handle(async (request, path) => {
      const user = context.auth.userOf(request);
      if (user === undefined) {
        return Response.json({ error: "signed_out" }, { status: 401 });
      }

      const parts = path.split("/");
      const [route, id] = parts;

      if (route === "providers") {
        return user.admin
          ? manage(request, parts)
          : Response.json({ error: "admin_only" }, { status: 403 });
      }

      if (route === "link" && id !== undefined && request.method === "GET") {
        return start(request, id, user.id);
      }

      if (route === "account" && request.method === "GET") {
        return Response.json(account(user));
      }

      if (route === "unlink" && request.method === "POST") {
        const { issuer } = (await request.json().catch(() => ({}))) as {
          issuer?: unknown;
        };

        if (typeof issuer !== "string") {
          return Response.json(
            { error: "issuer must be text" },
            { status: 400 },
          );
        }

        identities.unlink(user.id, issuer);
        context.log("identity unlinked", { userId: user.id, issuer });

        return Response.json(account(user));
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    });

    const account = (user: User): Account => ({
      admin: user.admin,
      providers: providers
        .list()
        .map(({ id, label, issuer }) => ({ id, label, issuer })),
      identities: identities.of(user.id),
    });
  },
};

// The groups come from the claim the provider puts them in. Emails count
// only once the provider has verified them.
function access(
  settings: ProviderConfig,
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
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${to}"><title>Pipoca</title><a href="${to}">Continue</a>`,
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
    `<!doctype html><meta charset="utf-8"><title>Pipoca</title><p>${escaped(message)}</p><p><a href="/">Back to Pipoca</a></p>`,
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
  readonly unlink: (userId: string, issuer: string) => void;
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
          "select issuer, email, linked_at, created from oidc_identities where user_id = ? order by linked_at",
          userId,
        ) as {
          issuer: string;
          email: string | null;
          linked_at: string;
          created: number;
        }[]
      ).map((row) => ({
        issuer: row.issuer,
        email: row.email,
        linkedAt: row.linked_at,
        created: row.created === 1,
      })),
    unlink: (userId, issuer) => {
      store.run(
        "delete from oidc_identities where user_id = ? and issuer = ? and created = 0",
        userId,
        issuer,
      );
    },
  };
}
