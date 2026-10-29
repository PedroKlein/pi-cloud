import { createHash, randomBytes } from "node:crypto";
import {
  BadRequest,
  fieldsOf,
  type PluginStore,
  readJson,
  type ServerPlugin,
  type User,
} from "@pipoca/plugins";
import type { GitLogin, RepositoryChoice } from "@pipoca/protocol";
import {
  authorizationUrl,
  HostRefused,
  loginOf,
  redeem,
  repositoriesOf,
} from "./github";
import { type HostConfig, hostStore, viewOf } from "./hosts";
import type { Account, Connection } from "./model";

// A browser has this long to come back from the host.
const attemptMs = 10 * 60_000;
const browserCookie = "pipoca-git-hosts";

interface Pending {
  readonly host: string;
  readonly userId: string;
  readonly browser: string;
  readonly expires: number;
}

// Each person connects their own account on each host, and the runner signs
// git and gh in with it in that person's Sessions (ADR 0043).
export const gitHosts: ServerPlugin = {
  name: "git-hosts",
  register: (context) => {
    const hosts = hostStore(
      context.config,
      context.store,
      process.env,
      context.log,
    );

    const connections = connectionStore(context.store);
    const pending = new Map<string, Pending>();

    context.auth.gitLogins((userId) =>
      connections
        .logins(userId)
        .filter(({ host }) => hosts.get(host) !== undefined),
    );

    const connect = async (
      userId: string,
      host: HostConfig,
      token: string,
    ): Promise<void> => {
      const login = await loginOf(host, token);
      connections.save(userId, host.host, login, token);

      context.log("host connected", {
        userId,
        host: host.host,
        login,
      });
    };

    // A host that can't be reached offers nothing, so the others still show.
    const repositories = async (
      userId: string,
      query: string,
    ): Promise<readonly RepositoryChoice[]> => {
      const found = await Promise.all(
        connections.logins(userId).map(async ({ host: name, token }) => {
          const host = hosts.get(name);
          if (host === undefined) {
            return [];
          }

          try {
            return (await repositoriesOf(host, token, query)).map(
              ({ url, name: full }) => ({ url, name: full, group: host.label }),
            );
          } catch (failure) {
            if (!(failure instanceof HostRefused)) {
              throw failure;
            }

            context.log("repository search failed", {
              host: name,
              error: failure.message,
            });

            return [];
          }
        }),
      );

      return found.flat();
    };

    const account = (user: User): Account => ({
      admin: user.admin,
      hosts: hosts.list().map(({ host, label, oauth }) => ({
        host,
        label,
        oauth: oauth?.clientSecret !== undefined,
      })),
      connections: connections.of(user.id),
    });

    const start = (request: Request, user: User, name: string): Response => {
      const host = hosts.get(name);
      const oauth = host?.oauth;

      if (host === undefined || oauth?.clientSecret === undefined) {
        return page(`${name} has no sign-in set up.`, 404);
      }

      const now = Date.now();
      for (const [state, each] of pending) {
        if (each.expires < now) {
          pending.delete(state);
        }
      }

      const state = randomBytes(32).toString("base64url");
      const browser = randomBytes(32).toString("base64url");

      pending.set(state, {
        host: host.host,
        userId: user.id,
        browser: hash(browser),
        expires: now + attemptMs,
      });

      return new Response(null, {
        status: 302,
        headers: {
          location: authorizationUrl(host, oauth, redirectUri(request), state),
          // Lax, since the host's redirect back is a cross-site navigation,
          // which leaves Strict cookies out.
          "set-cookie": new Bun.Cookie(browserCookie, browser, {
            path: "/api/plugins/git-hosts/",
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
      const host = attempt && hosts.get(attempt.host);

      const browser = new Bun.CookieMap(
        request.headers.get("cookie") ?? "",
      ).get(browserCookie);

      // The state must come back to the browser that left with it, so a
      // link can't connect someone else's account (RFC 6749, 10.12).
      if (
        attempt === undefined ||
        host?.oauth === undefined ||
        attempt.expires < Date.now() ||
        browser === null ||
        hash(browser) !== attempt.browser
      ) {
        return page("This sign-in has expired. Start it again.", 400);
      }

      pending.delete(params.get("state") ?? "");

      const error = params.get("error");
      if (error !== null) {
        return page(
          `${host.host} refused the sign-in: ${params.get("error_description") ?? error}`,
          403,
        );
      }

      try {
        const token = await redeem(
          host,
          host.oauth,
          redirectUri(request),
          params.get("code") ?? "",
        );

        await connect(attempt.userId, host, token);
      } catch (failure) {
        if (!(failure instanceof HostRefused)) {
          throw failure;
        }

        context.log("sign-in failed", {
          host: host.host,
          error: failure.message,
        });

        return page(failure.message, 502);
      }

      return redirect("/#settings/git-hosts");
    };

    // Admins add, change and remove hosts.
    const manage = async (
      request: Request,
      path: readonly string[],
    ): Promise<Response> => {
      const [, name, action] = path;

      if (name === undefined && request.method === "GET") {
        return Response.json(hosts.list().map(viewOf));
      }

      if (name === undefined && request.method === "POST") {
        const created = hosts.create(await readJson(request));
        context.log("host added", { host: created.host });

        return Response.json(viewOf(created), { status: 201 });
      }

      if (name !== undefined && action === "remove") {
        return hosts.remove(name)
          ? Response.json({ removed: name })
          : Response.json({ error: "not_found" }, { status: 404 });
      }

      if (name !== undefined && request.method === "POST") {
        const updated = hosts.update(name, await readJson(request));

        return updated === undefined
          ? Response.json({ error: "not_found" }, { status: 404 })
          : Response.json(viewOf(updated));
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    };

    context.auth.handlePublic(async (request, path) =>
      request.method === "GET" && path === "callback"
        ? callback(request)
        : undefined,
    );

    context.routes.handle(async (request, path) => {
      const user = context.auth.userOf(request);
      if (user === undefined) {
        return Response.json({ error: "signed_out" }, { status: 401 });
      }

      const parts = path.split("/");
      const [route, name] = parts;

      if (route === "hosts") {
        return user.admin
          ? await manage(request, parts)
          : Response.json({ error: "admin_only" }, { status: 403 });
      }

      if (route === "account" && request.method === "GET") {
        return Response.json(account(user));
      }

      if (route === "repositories" && request.method === "GET") {
        return Response.json(
          await repositories(
            user.id,
            new URL(request.url).searchParams.get("q")?.trim() ?? "",
          ),
        );
      }

      if (route === "sign-in" && name !== undefined) {
        return start(request, user, name);
      }

      if (route === "connect" && request.method === "POST") {
        const { host, token } = fieldsOf(await readJson(request));
        const listed = typeof host === "string" ? hosts.get(host) : undefined;

        if (listed === undefined) {
          throw new BadRequest("that host isn't listed");
        }

        if (typeof token !== "string" || token.trim() === "") {
          throw new BadRequest("paste a personal access token");
        }

        await connect(user.id, listed, token.trim()).catch(
          (failure: unknown) => {
            throw failure instanceof HostRefused
              ? new BadRequest(failure.message)
              : failure;
          },
        );

        return Response.json(account(user));
      }

      if (route === "disconnect" && request.method === "POST") {
        const { host } = fieldsOf(await readJson(request));

        if (typeof host !== "string") {
          throw new BadRequest("host must be text");
        }

        connections.remove(user.id, host);
        context.log("host disconnected", { userId: user.id, host });

        return Response.json(account(user));
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    });
  },
};

interface ConnectionStore {
  readonly of: (userId: string) => readonly Connection[];
  readonly logins: (userId: string) => readonly GitLogin[];
  readonly save: (
    userId: string,
    host: string,
    login: string,
    token: string,
  ) => void;
  readonly remove: (userId: string, host: string) => void;
}

// A connection is state people create as they go, so it lives in SQLite,
// with its token sealed for its user and host (ADR 0039).
function connectionStore(store: PluginStore): ConnectionStore {
  store.exec(`
    create table if not exists "git-hosts_connections" (
      user_id text not null,
      host text not null,
      login text not null,
      token text not null,
      connected_at text not null,
      primary key (user_id, host)
    )
  `);

  const rows = (
    userId: string,
  ): readonly {
    host: string;
    login: string;
    token: string;
    connected_at: string;
  }[] =>
    store.all(
      `select host, login, token, connected_at from "git-hosts_connections" where user_id = ? order by host`,
      userId,
    ) as { host: string; login: string; token: string; connected_at: string }[];

  return {
    of: (userId) =>
      rows(userId).map((row) => ({
        host: row.host,
        login: row.login,
        connectedAt: row.connected_at,
      })),
    // A token sealed under another server key can't be opened, and its
    // Sessions go without it, as if it weren't connected.
    logins: (userId) =>
      rows(userId).flatMap(({ host, token }) => {
        try {
          return [{ host, token: store.open(token, `${userId} ${host}`) }];
        } catch {
          return [];
        }
      }),
    save: (userId, host, login, token) => {
      store.run(
        `insert into "git-hosts_connections" (user_id, host, login, token, connected_at) values (?, ?, ?, ?, ?) on conflict (user_id, host) do update set login = excluded.login, token = excluded.token, connected_at = excluded.connected_at`,
        userId,
        host,
        login,
        store.seal(token, `${userId} ${host}`),
        new Date().toISOString(),
      );
    },
    remove: (userId, host) => {
      store.run(
        `delete from "git-hosts_connections" where user_id = ? and host = ?`,
        userId,
        host,
      );
    },
  };
}

// The Host header already passed the server's own site check.
function redirectUri(request: Request): string {
  const host = request.headers.get("host") ?? new URL(request.url).host;

  return `${secure(request) ? "https" : "http"}://${host}/api/plugins/git-hosts/callback`;
}

// HTTPS usually ends in a gateway in front of the server (ADR 0034).
function secure(request: Request): boolean {
  return (
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https"
  );
}

// A page that moves on by itself instead of a 302: the browser came here from
// the host's site, and would leave the Strict session cookie off a redirect
// it follows straight away.
function redirect(to: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${to}"><title>Pipoca</title><a href="${to}">Continue</a>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function page(message: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Pipoca</title><p>${escaped(message)}</p><p><a href="/#settings/git-hosts">Back to Pipoca</a></p>`,
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
