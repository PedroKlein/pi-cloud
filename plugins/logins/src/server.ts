import type {
  AuthType,
  Credential,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  BadRequest,
  fieldsOf,
  HttpError,
  type McpLoginState,
  NotFound,
  type PluginStore,
  readJson,
  type RouteCaller,
  type ServerPlugin,
  type ServerPluginContext,
} from "@pipoca/plugins";
import type { ModelRef } from "@pipoca/protocol";
import { callbacks, callbackUrl } from "./callback";
import { connections, modelSignIn } from "./connect";
import { type Locks, locks } from "./locks";
import {
  type McpOAuthState,
  type McpOAuthStateStore,
  mcpSignIn,
  signableServers,
} from "./mcp";
import {
  type Account,
  type Connectable,
  credentialOf,
  type Lease,
  mcpStateOf,
  type Stored,
} from "./model";

// Long enough for a token refresh, short enough that a runner that went away
// doesn't keep everyone else out for long.
const holdMs = 60_000;
// Under the server's idle timeout, so a waiting runner hears back and asks
// again instead of having its request cut.
const waitMs = 20_000;

// Each person's model and MCP logins live on the server, and their Sessions
// read and write them through it on every runner (ADR 0045).
export const logins: ServerPlugin = {
  name: "logins",
  register: (context) => {
    const leases = locks(holdMs, waitMs);

    const models = loginKind(context, leases, {
      name: "credentials",
      table: "logins_credentials",
      column: "provider",
      valid: credentialOf,
      typeOf: ({ type }) => type,
    });

    // Pi keeps one state per MCP server, with its client registration and
    // tokens, keyed by the server's name and address.
    const mcp = loginKind(context, leases, {
      name: "mcp",
      table: "logins_mcp",
      column: "server",
      valid: mcpStateOf,
      typeOf: () => "oauth",
    });

    // Pi's own providers and models, for the models a person's logins reach
    // and the providers Settings can sign them in to. Providers that
    // extensions add are already in the runners' lists, and take /login in a
    // Session.
    let catalog: readonly ModelRef[] = [];
    let connectable: readonly Connectable[] = [];

    void ModelRuntime.create({ modelsPath: null, allowModelNetwork: false })
      .then((runtime) => {
        catalog = runtime
          .getModels()
          .map(({ provider, id }) => ({ provider, id }));

        connectable = runtime.getProviders().flatMap(({ id, name, auth }) => {
          const methods = [
            ...(auth.oauth
              ? [
                  {
                    type: "oauth" as const,
                    label: auth.oauth.loginLabel ?? auth.oauth.name,
                  },
                ]
              : []),
            ...(auth.apiKey?.login
              ? [{ type: "api_key" as const, label: "API key" }]
              : []),
          ];

          return methods.length === 0 ? [] : [{ id, name, methods }];
        });
      })
      .catch((error: unknown) => {
        context.log("models not listed", { error: String(error) });
      });

    context.models.offer((_environmentId, userId) => {
      if (userId === undefined) {
        return { models: [] };
      }

      const providers = new Set(models.list(userId).map(({ key }) => key));

      return {
        models: catalog.filter(({ provider }) => providers.has(provider)),
      };
    });

    const signIns = connections(() => {
      context.changes.publish("logins");
    }, context.log);

    const returns = callbacks();

    context.auth.handlePublic((request, path) =>
      request.method === "GET" && path === "callback"
        ? returns.handle(request)
        : undefined,
    );

    const servers = () => signableServers(context.profiles.mcpServers());

    const account = (userId: string): Account => ({
      logins: models.list(userId).map(({ key, type, updatedAt }) => ({
        provider: key,
        type: type as Credential["type"],
        updatedAt,
      })),
      mcp: mcp.list(userId).map(({ key, updatedAt }) => ({
        server: key,
        updatedAt,
      })),
      servers: servers().map(({ key, name, url }) => ({
        key,
        name,
        url,
      })),
      ...withConnection(signIns.current(userId)),
    });

    context.routes.handle(async (request, path, caller) => {
      const userId = userOf(caller);
      const [route = "", key = "", action] = path.split("/");
      const kind = [models, mcp].find(({ name }) => name === route);

      if (caller.kind === "session") {
        if (kind === undefined) {
          throw new NotFound(`no route ${path}`);
        }

        return await kind.sessionRoute(request, userId, key, action);
      }

      if (route === "account" && request.method === "GET") {
        return Response.json(account(userId));
      }

      if (route === "save" && request.method === "POST") {
        const fields = fieldsOf(await readJson(request));

        const saved = await models.write(
          userId,
          textField(fields, "provider"),
          models.validated(fields["credential"]),
        );

        if (!saved) {
          throw busy();
        }

        return Response.json(account(userId));
      }

      if (route === "providers" && request.method === "GET") {
        return Response.json(connectable);
      }

      if (route === "connect" && request.method === "POST") {
        const fields = fieldsOf(await readJson(request));
        const provider = textField(fields, "provider");
        const type = fields["type"];

        const offered = connectable.find(({ id }) => id === provider);

        if (offered?.methods.some((method) => method.type === type) !== true) {
          throw new BadRequest(`${provider} takes no such login`);
        }

        signIns.start(
          userId,
          { key: provider, name: offered.name },
          modelSignIn(
            credentialsOf(models, userId),
            provider,
            type as AuthType,
          ),
        );

        return Response.json(account(userId));
      }

      if (route === "connect-mcp" && request.method === "POST") {
        const wanted = textField(fieldsOf(await readJson(request)), "server");
        const server = servers().find(({ key: each }) => each === wanted);

        if (server === undefined) {
          throw new BadRequest(`no MCP server ${wanted} to sign in to`);
        }

        const browser = returns.browser(request);

        signIns.start(
          userId,
          { key: server.key, name: server.name },
          mcpSignIn(
            server,
            mcpStateOfUser(mcp, userId, server.key),
            callbackUrl(request),
            returns.wait(browser.id),
          ),
        );

        return Response.json(account(userId), {
          headers: { "set-cookie": browser.cookie },
        });
      }

      if (
        route === "connection" &&
        key === "answer" &&
        request.method === "POST"
      ) {
        const fields = fieldsOf(await readJson(request));

        const answered = signIns.answer(
          userId,
          textField(fields, "prompt"),
          textField(fields, "answer"),
        );

        if (!answered) {
          throw new HttpError(
            409,
            "the sign-in isn't waiting for that answer",
            "not_asked",
          );
        }

        return Response.json(account(userId));
      }

      if (route === "connection" && request.method === "DELETE") {
        signIns.dismiss(userId);

        return Response.json(account(userId));
      }

      if (kind !== undefined && key !== "" && request.method === "DELETE") {
        const removed = await kind.write(userId, decodeURIComponent(key), null);

        if (!removed) {
          throw busy();
        }

        return Response.json(account(userId));
      }

      throw new NotFound(`no route ${path}`);
    });
  },
};

function withConnection(
  connection: Account["connection"],
): Pick<Account, "connection"> {
  return connection === undefined ? {} : { connection };
}

// The person's model logins as Pi reads and writes them while it signs them
// in on the server.
function credentialsOf(
  models: LoginKind<Credential>,
  userId: string,
): CredentialStore {
  return {
    read: async (providerId) => Promise.resolve(models.get(userId, providerId)),
    list: async () =>
      Promise.resolve(
        models.list(userId).map(({ key, type }) => ({
          providerId: key,
          type: type as Credential["type"],
        })),
      ),
    modify: async (providerId, fn) => models.modify(userId, providerId, fn),
    delete: async (providerId) => {
      await models.modify(userId, providerId, async () =>
        Promise.resolve(null),
      );
    },
  };
}

// One MCP server's sign-in state in the person's logins, as Pi's MCP sign-in
// reads and writes it.
function mcpStateOfUser(
  mcp: LoginKind<McpLoginState>,
  userId: string,
  key: string,
): McpOAuthStateStore {
  return {
    load: () => mcp.get(userId, key) as McpOAuthState | undefined,
    save: async (state) => {
      await mcp.modify(userId, key, async () =>
        Promise.resolve(state as unknown as McpLoginState),
      );
    },
  };
}

// Another Session of the person's holds the login, so the caller asks again.
function busy(): HttpError {
  return new HttpError(409, "another Session is changing this login", "busy");
}

function textField(fields: Readonly<Record<string, unknown>>, name: string) {
  const value = fields[name];
  if (typeof value !== "string" || value === "") {
    throw new BadRequest(`${name} must be text`);
  }

  return value;
}

// A Session uses the logins of the person who started it, or who started the
// Session that started it, as git hosts do (ADR 0043).
function userOf(caller: RouteCaller): string {
  return caller.kind === "session"
    ? (caller.session.startedBy ?? caller.session.ownerId)
    : caller.actor.slice("user:".length);
}

interface KindSpec<T> {
  // The first part of the Session routes.
  readonly name: string;
  readonly table: string;
  readonly column: string;
  readonly valid: (value: unknown) => T;
  readonly typeOf: (value: T) => string;
}

interface LoginKind<T> {
  readonly name: string;
  readonly list: (userId: string) => readonly Stored[];
  readonly get: (userId: string, key: string) => T | undefined;
  readonly validated: (value: unknown) => T;
  // Reads and writes the login under its lease. fn returns the new login,
  // null to remove it, or undefined to keep it. Throws LoginBusy when the
  // lease stays taken.
  readonly modify: (
    userId: string,
    key: string,
    fn: (current: T | undefined) => Promise<T | null | undefined>,
  ) => Promise<T | undefined>;
  // Takes the key's lease to write, or says false when it stays busy. Null
  // removes the login.
  readonly write: (
    userId: string,
    key: string,
    value: T | null,
  ) => Promise<boolean>;
  // What a Session asks for: every login's key, every value, or a lease on
  // one to read, refresh and write back.
  readonly sessionRoute: (
    request: Request,
    userId: string,
    key: string | undefined,
    action: string | undefined,
  ) => Promise<Response>;
}

function loginKind<T>(
  context: Pick<ServerPluginContext, "store" | "changes" | "log">,
  leases: Locks,
  spec: KindSpec<T>,
): LoginKind<T> {
  const rows = sealedRows(context.store, spec);

  const leaseKey = (userId: string, key: string): string =>
    `${spec.name}\u0000${userId}\u0000${key}`;

  const validated = (value: unknown): T => {
    try {
      return spec.valid(value);
    } catch (error) {
      throw new BadRequest(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const store = (userId: string, key: string, value: T | null): void => {
    const known = rows.get(userId, key) !== undefined;

    if (value === null) {
      rows.remove(userId, key);
    } else {
      rows.save(userId, key, value);
    }

    if (value === null || !known) {
      context.log(value === null ? "login removed" : "login saved", {
        kind: spec.name,
        userId,
        key,
      });
    }

    context.changes.publish("logins");
  };

  const lease = async (userId: string, key: string): Promise<Response> => {
    const given = await leases.acquire(leaseKey(userId, key));
    if (given === undefined) {
      throw busy();
    }

    const body: Lease<T> = {
      lease: given,
      value: rows.get(userId, key) ?? null,
    };

    return Response.json(body);
  };

  const release = async (
    request: Request,
    userId: string,
    key: string,
  ): Promise<Response> => {
    const { lease: given, value } = fieldsOf(await readJson(request));

    if (typeof given !== "string") {
      throw new BadRequest("lease must be text");
    }

    const next =
      value === undefined || value === null ? value : validated(value);

    // A lapsed lease may have let another runner write since, so its write
    // would undo theirs.
    const held = leaseKey(userId, key);
    if (next !== undefined && !leases.holds(held, given)) {
      throw new HttpError(
        409,
        "the lease lapsed, so this write could undo another",
        "lease_lapsed",
      );
    }

    if (next !== undefined) {
      store(userId, key, next);
    }

    leases.release(held, given);

    return Response.json({ ok: true });
  };

  const modify: LoginKind<T>["modify"] = async (userId, key, fn) => {
    const held = leaseKey(userId, key);
    const given = await leases.acquire(held);
    if (given === undefined) {
      throw new LoginBusy();
    }

    try {
      const current = rows.get(userId, key);
      const next = await fn(current);

      if (next !== undefined) {
        store(userId, key, next);
      }

      return next === undefined ? current : (next ?? undefined);
    } finally {
      leases.release(held, given);
    }
  };

  return {
    name: spec.name,
    list: rows.list,
    get: rows.get,
    validated,
    modify,
    write: async (userId, key, value) => {
      try {
        await modify(userId, key, async () => Promise.resolve(value));

        return true;
      } catch (error) {
        if (error instanceof LoginBusy) {
          return false;
        }

        throw error;
      }
    },
    sessionRoute: async (request, userId, rawKey, action) => {
      if (rawKey === undefined || rawKey === "") {
        return Response.json(
          new URL(request.url).searchParams.has("values")
            ? Object.fromEntries(
                rows.list(userId).flatMap(({ key }) => {
                  const value = rows.get(userId, key);

                  return value === undefined ? [] : [[key, value]];
                }),
              )
            : rows.list(userId).map(({ key, type }) => ({ key, type })),
        );
      }

      const key = decodeURIComponent(rawKey);

      if (action === "lock" && request.method === "POST") {
        return lease(userId, key);
      }

      if (action === "release" && request.method === "POST") {
        return release(request, userId, key);
      }

      throw new NotFound(`no route ${spec.name}/${rawKey}`);
    },
  };
}

interface SealedRows<T> {
  readonly list: (userId: string) => readonly Stored[];
  readonly get: (userId: string, key: string) => T | undefined;
  readonly save: (userId: string, key: string, value: T) => void;
  readonly remove: (userId: string, key: string) => void;
}

// A login is state people create as they go, so it lives in SQLite, sealed
// for its user and key (ADR 0039).
function sealedRows<T>(
  store: PluginStore,
  { table, column, valid, typeOf }: KindSpec<T>,
): SealedRows<T> {
  store.exec(`
    create table if not exists "${table}" (
      user_id text not null,
      ${column} text not null,
      type text not null,
      credential text not null,
      updated_at text not null,
      primary key (user_id, ${column})
    )
  `);

  const sealedFor = (userId: string, key: string): string => `${userId} ${key}`;

  return {
    list: (userId) =>
      (
        store.all(
          `select ${column} as key, type, updated_at from "${table}" where user_id = ? order by ${column}`,
          userId,
        ) as { key: string; type: string; updated_at: string }[]
      ).map(({ key, type, updated_at }) => ({
        key,
        type,
        updatedAt: updated_at,
      })),
    // A login sealed under another server key can't be opened, and reads as
    // logged out.
    get: (userId, key) => {
      const [row] = store.all(
        `select credential from "${table}" where user_id = ? and ${column} = ?`,
        userId,
        key,
      ) as { credential: string }[];

      if (row === undefined) {
        return undefined;
      }

      try {
        return valid(
          JSON.parse(store.open(row.credential, sealedFor(userId, key))),
        );
      } catch {
        return undefined;
      }
    },
    save: (userId, key, value) => {
      store.run(
        `insert into "${table}" (user_id, ${column}, type, credential, updated_at) values (?, ?, ?, ?, ?) on conflict (user_id, ${column}) do update set type = excluded.type, credential = excluded.credential, updated_at = excluded.updated_at`,
        userId,
        key,
        typeOf(value),
        store.seal(JSON.stringify(value), sealedFor(userId, key)),
        new Date().toISOString(),
      );
    },
    remove: (userId, key) => {
      store.run(
        `delete from "${table}" where user_id = ? and ${column} = ?`,
        userId,
        key,
      );
    },
  };
}

class LoginBusy extends Error {
  constructor() {
    super("another runner holds this login");
  }
}
