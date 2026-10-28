import type { HostConfig, OAuthApp } from "./hosts";

// What a host answered, in words for the person connecting.
export class HostRefused extends Error {}

const timeoutMs = 15_000;

// The account a token signs in as, which also proves the token works.
export async function loginOf(
  host: HostConfig,
  token: string,
): Promise<string> {
  const response = await reach(host, `${host.api}/user`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401) {
    throw new HostRefused(`${host.host} doesn't accept this token`);
  }

  if (!response.ok) {
    throw new HostRefused(
      `${host.host} answered ${String(response.status)} when asked who the token belongs to`,
    );
  }

  const { login } = (await response.json()) as { login?: unknown };

  if (typeof login !== "string") {
    throw new HostRefused(`${host.host} didn't say who the token belongs to`);
  }

  return login;
}

// GitHub's web flow for OAuth apps. repo covers private repositories and
// pushes, read:org the organizations' repositories.
export function authorizationUrl(
  host: HostConfig,
  oauth: OAuthApp,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: oauth.clientId,
    redirect_uri: redirectUri,
    scope: "repo read:org",
    state,
  });

  return `https://${host.host}/login/oauth/authorize?${params.toString()}`;
}

export async function redeem(
  host: HostConfig,
  oauth: OAuthApp,
  redirectUri: string,
  code: string,
): Promise<string> {
  const response = await reach(
    host,
    `https://${host.host}/login/oauth/access_token`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    },
  );

  const answer = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    error_description?: unknown;
    error?: unknown;
  };

  if (typeof answer.access_token !== "string") {
    const reason = answer.error_description ?? answer.error;

    throw new HostRefused(
      typeof reason === "string"
        ? `${host.host} refused the sign-in: ${reason}`
        : `${host.host} answered ${String(response.status)} to the sign-in`,
    );
  }

  return answer.access_token;
}

export interface Repository {
  // What git clones.
  readonly url: string;
  // owner/name
  readonly name: string;
}

// The repositories the token's account pushed to last, those of them whose
// name holds the query, and with a query, the matching ones anywhere on the
// host it can see.
export async function repositoriesOf(
  host: HostConfig,
  token: string,
  query: string,
): Promise<readonly Repository[]> {
  const get = async (path: string): Promise<unknown> => {
    const response = await reach(host, `${host.api}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new HostRefused(
        `${host.host} answered ${String(response.status)} to ${path}`,
      );
    }

    return response.json();
  };

  const needle = query.toLowerCase();

  const [mine, searched] = await Promise.all([
    get("/user/repos?sort=pushed&per_page=100"),
    query.length < 2
      ? { items: [] }
      : get(
          `/search/repositories?per_page=30&q=${encodeURIComponent(`${query} in:name`)}`,
        ),
  ]);

  const found = [
    ...repositoriesIn(mine).filter(({ name }) =>
      name.toLowerCase().includes(needle),
    ),
    ...repositoriesIn((searched as { items?: unknown }).items),
  ];

  return found.filter(
    (repository, index) =>
      found.findIndex(({ url }) => url === repository.url) === index,
  );
}

function repositoriesIn(list: unknown): readonly Repository[] {
  return (Array.isArray(list) ? list : []).flatMap((item: unknown) => {
    const { clone_url: url, full_name: name } = (item ?? {}) as {
      clone_url?: unknown;
      full_name?: unknown;
    };

    return typeof url === "string" && typeof name === "string"
      ? [{ url, name }]
      : [];
  });
}

async function reach(
  host: HostConfig,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (failure) {
    throw new HostRefused(
      `couldn't reach ${host.host}: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }
}
