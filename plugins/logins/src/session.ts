import type {
  AuthOperationOptions,
  Credential,
  CredentialStore,
} from "@earendil-works/pi-ai";
import type {
  McpLoginState,
  McpLoginStore,
  SessionCloud,
  SessionPlugin,
} from "@pipoca/plugins";
import { type Lease, mcpKey, type Release } from "./model";

// The server answers busy after waiting a while for another runner's
// refresh, so a few asks cover a slow one.
const busyAsks = 5;

// The Session's model and MCP logins are its owner's on the server, so
// /login, /mcp login and token refreshes reach every runner (ADR 0045).
export const logins: SessionPlugin = {
  name: "logins",
  logins: async (cloud) => {
    const models = leased<Credential>(cloud, "credentials");

    return {
      models: modelLogins(models),
      mcp: await mcpLogins(leased<McpLoginState>(cloud, "mcp"), cloud.log),
    };
  },
};

interface Leased<T> {
  readonly keys: (
    options?: AuthOperationOptions,
  ) => Promise<readonly { readonly key: string; readonly type: string }[]>;
  readonly values: (
    options?: AuthOperationOptions,
  ) => Promise<Readonly<Record<string, T>>>;
  // Runs fn while the Session holds the login's lease, and writes back what
  // it returns as next. The lease is let go even when fn throws, so the next
  // runner doesn't wait for it to lapse.
  readonly withLease: <R>(
    key: string,
    fn: (current: T | undefined) => Promise<{
      readonly result: R;
      readonly next?: T | null;
    }>,
    options?: AuthOperationOptions,
  ) => Promise<R>;
}

// One kind of login on the server, through the Session's requests to it.
function leased<T>(
  { request }: Pick<SessionCloud, "request">,
  kind: string,
): Leased<T> {
  const call = async <R>(
    path: string,
    init: RequestInit,
    options?: AuthOperationOptions,
  ): Promise<R> => {
    const response = await request(path, {
      ...init,
      ...(options?.signal && { signal: options.signal }),
    });

    if (!response.ok) {
      const { error, message } = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };

      throw new LoginsError(
        response.status,
        error,
        message ?? `the server answered ${String(response.status)}`,
      );
    }

    return (await response.json()) as R;
  };

  const pathOf = (key: string): string => `${kind}/${encodeURIComponent(key)}`;

  const lock = async (
    key: string,
    options?: AuthOperationOptions,
  ): Promise<Lease<T>> => {
    for (let ask = 1; ; ask++) {
      try {
        return await call<Lease<T>>(
          `${pathOf(key)}/lock`,
          { method: "POST" },
          options,
        );
      } catch (error) {
        if (!(error instanceof LoginsError && error.busy) || ask === busyAsks) {
          throw error;
        }
      }
    }
  };

  const release = async (key: string, body: Release<T>): Promise<void> => {
    await call(`${pathOf(key)}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  return {
    keys: async (options) => call(kind, {}, options),
    values: async (options) => call(`${kind}?values`, {}, options),
    withLease: async (key, fn, options) => {
      const { lease, value } = await lock(key, options);

      let outcome: Awaited<ReturnType<typeof fn>>;
      try {
        outcome = await fn(value ?? undefined);
      } catch (error) {
        await release(key, { lease }).catch(() => undefined);
        throw error;
      }

      await release(key, {
        lease,
        ...(outcome.next !== undefined && { value: outcome.next }),
      });

      return outcome.result;
    },
  };
}

function modelLogins(models: Leased<Credential>): CredentialStore {
  // Pi checks every provider at once, so the reads that start together share
  // one request for all of the owner's logins.
  let reading: Promise<Readonly<Record<string, Credential>>> | undefined;

  return {
    read: async (providerId, options) => {
      reading ??= models.values(options).finally(() => {
        reading = undefined;
      });

      return (await reading)[providerId];
    },
    list: async (options) =>
      (await models.keys(options)).map(({ key, type }) => ({
        providerId: key,
        type: type as Credential["type"],
      })),
    modify: async (providerId, fn, options) =>
      models.withLease(
        providerId,
        async (current) => {
          const next = await fn(current);

          return { result: next ?? current, ...(next && { next }) };
        },
        options,
      ),
    delete: async (providerId, options) => {
      await models.withLease(
        providerId,
        async () => Promise.resolve({ result: undefined, next: null }),
        options,
      );
    },
  };
}

// Pi reads and writes MCP sign-ins without waiting, so the Session keeps the
// owner's in memory, loaded when it starts, and writes each change back in
// order. A token refresh holds the server's lease, reading the newest state
// first, so two runners don't spend one refresh token.
async function mcpLogins(
  mcp: Leased<McpLoginState>,
  log: SessionCloud["log"],
): Promise<McpLoginStore> {
  const states = new Map(Object.entries(await mcp.values()));
  const refreshing = new Set<string>();
  let writes = Promise.resolve();

  const writeBack = (key: string, next: McpLoginState | null): void => {
    writes = writes
      .then(async () =>
        mcp.withLease(key, async () =>
          Promise.resolve({ result: undefined, next }),
        ),
      )
      .catch((error: unknown) => {
        log("MCP login not saved", { server: key, error: String(error) });
      });
  };

  return {
    forServer: (name, serverUrl) => {
      const key = mcpKey(name, serverUrl);

      return {
        load: () => states.get(key),
        save: (state) => {
          states.set(key, state);

          if (!refreshing.has(key)) {
            writeBack(key, state);
          }
        },
        withRefreshLock: async (fn) =>
          mcp.withLease(key, async (current) => {
            if (current === undefined) {
              states.delete(key);
            } else {
              states.set(key, current);
            }

            refreshing.add(key);
            try {
              const result = await fn();
              const next = states.get(key);

              return {
                result,
                ...(next !== current && { next: next ?? null }),
              };
            } finally {
              refreshing.delete(key);
            }
          }),
      };
    },
    tokens: (name, serverUrl) => states.get(mcpKey(name, serverUrl))?.tokens,
    remove: (name, serverUrl) => {
      const key = mcpKey(name, serverUrl);
      const removed = states.delete(key);

      if (removed) {
        writeBack(key, null);
      }

      return removed;
    },
  };
}

class LoginsError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  get busy(): boolean {
    return this.status === 409 && this.code === "busy";
  }
}
