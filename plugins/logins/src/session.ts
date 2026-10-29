import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import type { SessionCloud, SessionPlugin } from "@pipoca/plugins";
import type { Lease, Release } from "./model";

// The server answers busy after waiting a while for another runner's
// refresh, so a few asks cover a slow one.
const busyAsks = 5;

// The Session's model logins are its owner's on the server, so /login, /logout
// and token refreshes reach every runner (ADR 0045).
export const logins: SessionPlugin = {
  name: "logins",
  credentials: (cloud) => serverCredentials(cloud),
};

function serverCredentials({
  request,
}: Pick<SessionCloud, "request">): CredentialStore {
  const call = async <T>(
    path: string,
    init: RequestInit,
    options?: AuthOperationOptions,
  ): Promise<T> => {
    const response = await request(path, {
      ...init,
      ...(options?.signal && { signal: options.signal }),
    });

    if (!response.ok) {
      const { error } = (await response.json().catch(() => ({}))) as {
        error?: string;
      };

      throw new LoginsError(
        response.status,
        error ?? `the server answered ${String(response.status)}`,
      );
    }

    return (await response.json()) as T;
  };

  // Pi checks every provider at once, so the reads that start together share
  // one request for all of the owner's logins.
  let reading: Promise<Readonly<Record<string, Credential>>> | undefined;

  const read = async (
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> => {
    reading ??= call<Readonly<Record<string, Credential>>>(
      "credentials?values",
      {},
      options,
    ).finally(() => {
      reading = undefined;
    });

    return (await reading)[providerId];
  };

  const pathOf = (providerId: string): string =>
    `credentials/${encodeURIComponent(providerId)}`;

  const lock = async (
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Lease> => {
    for (let ask = 1; ; ask++) {
      try {
        return await call<Lease>(
          `${pathOf(providerId)}/lock`,
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

  const release = async (providerId: string, body: Release): Promise<void> => {
    await call(`${pathOf(providerId)}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  // The lease is let go even when fn throws or the Session gives up, so the
  // next runner doesn't wait for it to lapse.
  const withLease = async (
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Release["credential"]>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> => {
    const { lease, credential } = await lock(providerId, options);
    const current = credential ?? undefined;

    let next: Release["credential"];
    try {
      next = await fn(current);
    } catch (error) {
      await release(providerId, { lease }).catch(() => undefined);
      throw error;
    }

    await release(providerId, {
      lease,
      ...(next !== undefined && { credential: next }),
    });

    return next === undefined ? current : (next ?? undefined);
  };

  return {
    read,
    list: async (options) =>
      call<readonly CredentialInfo[]>("credentials", {}, options),
    modify: async (providerId, fn, options) =>
      withLease(providerId, fn, options),
    delete: async (providerId, options) => {
      await withLease(providerId, async () => Promise.resolve(null), options);
    },
  };
}

class LoginsError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }

  get busy(): boolean {
    return this.status === 409 && this.message === "busy";
  }
}
