import {
  BadRequest,
  HttpError,
  isObject,
  NotFound,
  type OfferedModels,
  type PluginStore,
  readJson,
  requireAdmin,
  type ServerPlugin,
} from "@pipoca/plugins";
import { aliasesOf, gatewayProvider } from "./gateway";
import {
  type AliasConfig,
  aliasProblem,
  type EnvironmentModels,
  type Health,
  healthFrom,
  mergeHealth,
  noHealth,
  type SessionConfig,
  storedAliases,
} from "./model";

// Below the server's 30 second idle timeout.
const waitMs = 20_000;

export const models: ServerPlugin = {
  name: "models",
  register: (context) => {
    const store = modelsStore(context.store);
    const versions = changes(context.signal);

    context.models.offer((environmentId) =>
      offered(store.get(environmentId).aliases),
    );

    context.routes.handle(async (request, path, caller) => {
      const method = request.method;

      if (caller.kind === "session") {
        const { environmentId } = caller.session;

        if (method === "GET" && path === "config") {
          const after = new URL(request.url).searchParams.get("after");
          if (after !== null) {
            // A Session polls again at once after any answer, and backs off
            // only after an error.
            if (context.signal.aborted) {
              throw new HttpError(503, "the server is stopping", "stopping");
            }

            await versions.changed(
              environmentId,
              Number(after),
              request.signal,
            );
          }

          const config = {
            version: versions.of(environmentId),
            ...store.get(environmentId),
          } satisfies SessionConfig;

          return Response.json(config);
        }

        if (method === "POST" && path === "health") {
          const reported = healthFrom(await readJson(request));
          if (reported === undefined) {
            throw new BadRequest(
              "model health report not understood",
              "invalid_health",
            );
          }

          const current = store.get(environmentId).health;
          const health = mergeHealth(current, reported, new Date());
          if (JSON.stringify(health) !== JSON.stringify(current)) {
            store.setHealth(environmentId, health);
            versions.bump(environmentId);

            context.log("model health changed", {
              environmentId,
              unhealthy: Object.keys(health.unhealthyUntil),
              session: caller.session.id,
            });
          }

          return new Response(null, { status: 204 });
        }

        throw new NotFound(`no route ${path}`);
      }

      const [resource, environmentId] = path.split("/");
      if (resource !== "environments") {
        throw new NotFound(`no route ${path}`);
      }

      if (method === "GET" && environmentId === undefined) {
        return Response.json(store.all());
      }

      if (method === "POST" && environmentId !== undefined) {
        requireAdmin(caller, "only admins change model aliases");

        const body = await readJson(request);
        if (!isObject(body) || !("aliases" in body)) {
          throw new BadRequest("aliases must be a config or null");
        }

        const { aliases } = body;
        const problem = aliases === null ? undefined : aliasProblem(aliases);
        if (problem !== undefined) {
          throw new BadRequest(problem);
        }

        store.setAliases(environmentId, aliases as AliasConfig | null);
        versions.bump(environmentId);
        context.log("aliases changed", { environmentId });

        return Response.json(store.get(environmentId));
      }

      throw new NotFound(`no route ${path}`);
    });
  },
};

function offered(aliases: AliasConfig | null): OfferedModels {
  if (aliases === null) {
    return { models: [] };
  }

  const refs = aliasesOf(aliases).map((id) => ({
    provider: gatewayProvider,
    id,
  }));

  const fallback = refs.find(({ id }) => id === aliases.defaultAlias);

  return { models: refs, ...(fallback && { default: fallback }) };
}

interface ModelsStore {
  readonly all: () => readonly EnvironmentModels[];
  readonly get: (environmentId: string) => EnvironmentModels;
  readonly setAliases: (
    environmentId: string,
    aliases: AliasConfig | null,
  ) => void;
  readonly setHealth: (environmentId: string, health: Health) => void;
}

interface Row {
  readonly environment_id: string;
  readonly aliases: string | null;
  readonly health: string | null;
}

function modelsStore(store: PluginStore): ModelsStore {
  store.exec(`create table if not exists models_environments (
    environment_id text primary key,
    aliases text,
    health text
  )`);

  const parsed = (row: Row): EnvironmentModels => ({
    environmentId: row.environment_id,
    aliases:
      row.aliases === null ? null : storedAliases(JSON.parse(row.aliases)),
    health: row.health === null ? noHealth : (JSON.parse(row.health) as Health),
  });

  const get = (environmentId: string): EnvironmentModels => {
    const [row] = store.all(
      "select * from models_environments where environment_id = ?",
      environmentId,
    ) as Row[];

    return row
      ? parsed(row)
      : { environmentId, aliases: null, health: noHealth };
  };

  return {
    all: () =>
      (store.all("select * from models_environments") as Row[]).map(parsed),
    get,
    setAliases: (environmentId, aliases) => {
      store.run(
        `insert into models_environments (environment_id, aliases) values (?, ?)
         on conflict (environment_id) do update set aliases = excluded.aliases`,
        environmentId,
        aliases === null ? null : JSON.stringify(aliases),
      );
    },
    setHealth: (environmentId, health) => {
      store.run(
        `insert into models_environments (environment_id, health) values (?, ?)
         on conflict (environment_id) do update set health = excluded.health`,
        environmentId,
        JSON.stringify(health),
      );
    },
  };
}

// A version per Environment that Sessions wait on. It starts from the clock,
// so a Session that saw a version before a restart never sees it again.
function changes(signal: AbortSignal): {
  readonly of: (environmentId: string) => number;
  readonly bump: (environmentId: string) => void;
  readonly changed: (
    environmentId: string,
    seen: number,
    request: AbortSignal,
  ) => Promise<void>;
} {
  const start = Date.now();
  const versions = new Map<string, number>();
  const waiting = new Map<string, Set<() => void>>();

  const of = (environmentId: string): number =>
    versions.get(environmentId) ?? start;

  return {
    of,
    bump: (environmentId) => {
      versions.set(environmentId, of(environmentId) + 1);

      for (const wake of waiting.get(environmentId) ?? []) {
        wake();
      }

      waiting.delete(environmentId);
    },
    changed: async (environmentId, seen, request) => {
      if (of(environmentId) !== seen || request.aborted) {
        return;
      }

      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          request.removeEventListener("abort", wake);
          signal.removeEventListener("abort", wake);
          waiting.get(environmentId)?.delete(wake);
          resolve();
        };

        const timer = setTimeout(wake, waitMs);
        const set = waiting.get(environmentId) ?? new Set();
        set.add(wake);
        waiting.set(environmentId, set);

        request.addEventListener("abort", wake, { once: true });
        signal.addEventListener("abort", wake, { once: true });
      });
    },
  };
}
