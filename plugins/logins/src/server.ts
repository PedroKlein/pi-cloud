import type { Credential } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  BadRequest,
  fieldsOf,
  type PluginStore,
  readJson,
  type RouteCaller,
  type ServerPlugin,
} from "@pipoca/plugins";
import type { ModelRef } from "@pipoca/protocol";
import { locks } from "./locks";
import {
  type Account,
  credentialOf,
  type Lease,
  type LoginView,
} from "./model";

// Long enough for a token refresh, short enough that a runner that went away
// doesn't keep everyone else out for long.
const holdMs = 60_000;
// Under the server's idle timeout, so a waiting runner hears back and asks
// again instead of having its request cut.
const waitMs = 20_000;

// Each person's model logins live on the server, and their Sessions read and
// write them through it on every runner (ADR 0045).
export const logins: ServerPlugin = {
  name: "logins",
  register: (context) => {
    const credentials = credentialStore(context.store);
    const leases = locks(holdMs, waitMs);

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

      const providers = new Set(
        credentials.of(userId).map(({ provider }) => provider),
      );

      return {
        models: catalog.filter(({ provider }) => providers.has(provider)),
      };
    });

    const changed = (): void => {
      context.changes.publish("logins");
    };

    const keyOf = (userId: string, provider: string): string =>
      `${userId}\u0000${provider}`;

    const lease = async (
      userId: string,
      provider: string,
    ): Promise<Response> => {
      const given = await leases.acquire(keyOf(userId, provider));
      if (given === undefined) {
        return Response.json({ error: "busy" }, { status: 409 });
      }

      const body: Lease = {
        lease: given,
        credential: credentials.get(userId, provider) ?? null,
      };

      return Response.json(body);
    };

    const release = async (
      request: Request,
      userId: string,
      provider: string,
    ): Promise<Response> => {
      const fields = fieldsOf(await readJson(request));
      const { lease: given, credential } = fields;

      if (typeof given !== "string") {
        throw new BadRequest("lease must be text");
      }

      const next =
        credential === undefined || credential === null
          ? credential
          : validCredential(credential);

      // A lapsed lease may have let another runner write since, so its
      // write would undo theirs.
      const key = keyOf(userId, provider);
      if (next !== undefined && !leases.holds(key, given)) {
        return Response.json({ error: "lease_lapsed" }, { status: 409 });
      }

      if (next === null) {
        credentials.remove(userId, provider);
        context.log("login removed", { userId, provider });
        changed();
      } else if (next !== undefined) {
        const stored = credentials.get(userId, provider);
        credentials.save(userId, provider, next);

        if (stored === undefined) {
          context.log("login saved", { userId, provider, type: next.type });
        }

        changed();
      }

      leases.release(key, given);

      return Response.json({ ok: true });
    };

    const sessionRoutes = async (
      request: Request,
      parts: readonly string[],
      userId: string,
    ): Promise<Response> => {
      const [route, rawProvider, action] = parts;

      if (route !== "credentials") {
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      if (
        (rawProvider === undefined || rawProvider === "") &&
        new URL(request.url).searchParams.has("values")
      ) {
        return Response.json(
          Object.fromEntries(
            credentials.of(userId).flatMap(({ provider }) => {
              const credential = credentials.get(userId, provider);

              return credential === undefined ? [] : [[provider, credential]];
            }),
          ),
        );
      }

      if (rawProvider === undefined || rawProvider === "") {
        return Response.json(
          credentials
            .of(userId)
            .map(({ provider, type }) => ({ providerId: provider, type })),
        );
      }

      const provider = decodeURIComponent(rawProvider);

      if (action === "lock" && request.method === "POST") {
        return lease(userId, provider);
      }

      if (action === "release" && request.method === "POST") {
        return release(request, userId, provider);
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    };

    const account = (userId: string): Account => ({
      logins: credentials.of(userId),
    });

    context.routes.handle(async (request, path, caller) => {
      const userId = userOf(caller);
      const parts = path.split("/");

      if (caller.kind === "session") {
        return sessionRoutes(request, parts, userId);
      }

      const [route] = parts;

      if (route === "account" && request.method === "GET") {
        return Response.json(account(userId));
      }

      if (route === "save" && request.method === "POST") {
        const { provider, credential } = fieldsOf(await readJson(request));
        if (typeof provider !== "string" || provider === "") {
          throw new BadRequest("provider must be text");
        }

        const next = validCredential(credential);
        const key = keyOf(userId, provider);
        const given = await leases.acquire(key);
        if (given === undefined) {
          return Response.json({ error: "busy" }, { status: 409 });
        }

        credentials.save(userId, provider, next);
        leases.release(key, given);
        context.log("login saved", { userId, provider, type: next.type });
        changed();

        return Response.json(account(userId));
      }

      if (route === "remove" && request.method === "POST") {
        const { provider } = fieldsOf(await readJson(request));
        if (typeof provider !== "string") {
          throw new BadRequest("provider must be text");
        }

        const key = keyOf(userId, provider);
        const given = await leases.acquire(key);
        if (given === undefined) {
          return Response.json({ error: "busy" }, { status: 409 });
        }

        credentials.remove(userId, provider);
        leases.release(key, given);
        context.log("login removed", { userId, provider });
        changed();

        return Response.json(account(userId));
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    });
  },
};

function validCredential(value: unknown): Credential {
  try {
    return credentialOf(value);
  } catch (error) {
    throw new BadRequest(
      error instanceof Error ? error.message : String(error),
    );
  }
}

// A Session uses the logins of the person who started it, or who started the
// Session that started it, as git hosts do (ADR 0043).
function userOf(caller: RouteCaller): string {
  return caller.kind === "session"
    ? (caller.session.startedBy ?? caller.session.ownerId)
    : caller.actor.slice("user:".length);
}

interface CredentialStore {
  readonly of: (userId: string) => readonly LoginView[];
  readonly get: (userId: string, provider: string) => Credential | undefined;
  readonly save: (
    userId: string,
    provider: string,
    credential: Credential,
  ) => void;
  readonly remove: (userId: string, provider: string) => void;
}

// A login is state people create as they go, so it lives in SQLite, sealed
// for its user and provider (ADR 0039).
function credentialStore(store: PluginStore): CredentialStore {
  store.exec(`
    create table if not exists "logins_credentials" (
      user_id text not null,
      provider text not null,
      type text not null,
      credential text not null,
      updated_at text not null,
      primary key (user_id, provider)
    )
  `);

  const context = (userId: string, provider: string): string =>
    `${userId} ${provider}`;

  return {
    of: (userId) =>
      (
        store.all(
          `select provider, type, updated_at from "logins_credentials" where user_id = ? order by provider`,
          userId,
        ) as {
          provider: string;
          type: Credential["type"];
          updated_at: string;
        }[]
      ).map(({ provider, type, updated_at }) => ({
        provider,
        type,
        updatedAt: updated_at,
      })),
    // A login sealed under another server key can't be opened, and reads as
    // logged out.
    get: (userId, provider) => {
      const [row] = store.all(
        `select credential from "logins_credentials" where user_id = ? and provider = ?`,
        userId,
        provider,
      ) as { credential: string }[];

      if (row === undefined) {
        return undefined;
      }

      try {
        return credentialOf(
          JSON.parse(store.open(row.credential, context(userId, provider))),
        );
      } catch {
        return undefined;
      }
    },
    save: (userId, provider, credential) => {
      store.run(
        `insert into "logins_credentials" (user_id, provider, type, credential, updated_at) values (?, ?, ?, ?, ?) on conflict (user_id, provider) do update set type = excluded.type, credential = excluded.credential, updated_at = excluded.updated_at`,
        userId,
        provider,
        credential.type,
        store.seal(JSON.stringify(credential), context(userId, provider)),
        new Date().toISOString(),
      );
    },
    remove: (userId, provider) => {
      store.run(
        `delete from "logins_credentials" where user_id = ? and provider = ?`,
        userId,
        provider,
      );
    },
  };
}
