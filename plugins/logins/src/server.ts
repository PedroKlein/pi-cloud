import type { Credential } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  BadRequest,
  fieldsOf,
  type PluginStore,
  readJson,
  type RouteCaller,
  type ServerPlugin,
  type ServerPluginContext,
} from "@pipoca/plugins";
import type { ModelRef } from "@pipoca/protocol";
import { type Locks, locks } from "./locks";
import {
  type Account,
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

    // Pi's own models, by provider, for the models a person's logins reach.
    // Providers that extensions add are already in the runners' lists.
    let catalog: readonly ModelRef[] = [];

    void ModelRuntime.create({ modelsPath: null, allowModelNetwork: false })
      .then((runtime) => {
        catalog = runtime
          .getModels()
          .map(({ provider, id }) => ({ provider, id }));
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
    });

    context.routes.handle(async (request, path, caller) => {
      const userId = userOf(caller);
      const [route = "", key, action] = path.split("/");

      if (caller.kind === "session") {
        const kind = [models, mcp].find(({ name }) => name === route);

        return kind === undefined
          ? Response.json({ error: "not_found" }, { status: 404 })
          : kind.sessionRoute(request, userId, key, action);
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

        return saved
          ? Response.json(account(userId))
          : Response.json({ error: "busy" }, { status: 409 });
      }

      if (route === "remove" && request.method === "POST") {
        const fields = fieldsOf(await readJson(request));

        const removed =
          fields["server"] === undefined
            ? await models.write(userId, textField(fields, "provider"), null)
            : await mcp.write(userId, textField(fields, "server"), null);

        return removed
          ? Response.json(account(userId))
          : Response.json({ error: "busy" }, { status: 409 });
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    });
  },
};

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
  readonly validated: (value: unknown) => T;
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
      return Response.json({ error: "busy" }, { status: 409 });
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
      return Response.json({ error: "lease_lapsed" }, { status: 409 });
    }

    if (next !== undefined) {
      store(userId, key, next);
    }

    leases.release(held, given);

    return Response.json({ ok: true });
  };

  return {
    name: spec.name,
    list: rows.list,
    validated,
    write: async (userId, key, value) => {
      const held = leaseKey(userId, key);
      const given = await leases.acquire(held);
      if (given === undefined) {
        return false;
      }

      store(userId, key, value);
      leases.release(held, given);

      return true;
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

      return Response.json({ error: "not_found" }, { status: 404 });
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
