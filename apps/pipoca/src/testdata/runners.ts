import type { Environment, Joined } from "@pipoca/protocol";

// Keys and runner tokens of one server's Environments, made on first use.
// A new key would let go of the runners that joined with the one before.
export function runnerCredentials(
  server: { readonly url: URL },
  cookie: () => Promise<string>,
): {
  readonly key: (environment: string) => Promise<string>;
  readonly token: (runner: string, environment?: string) => Promise<string>;
} {
  const keys = new Map<string, Promise<string>>();
  const tokens = new Map<string, Promise<string>>();

  const makeKey = async (environment: string): Promise<string> => {
    const headers = {
      "content-type": "application/json",
      cookie: await cookie(),
    };

    const created = await fetch(new URL("/api/environments", server.url), {
      method: "POST",
      headers,
      body: JSON.stringify({ name: environment }),
    });

    if (created.status === 201) {
      return ((await created.json()) as { key: string }).key;
    }

    const listed = (await (
      await fetch(new URL("/api/environments", server.url), { headers })
    ).json()) as Environment[];

    const id = listed.find(({ provider }) => provider === environment)?.id;

    const replaced = await fetch(
      new URL(`/api/environments/${id ?? ""}/key`, server.url),
      { method: "POST", headers, body: "{}" },
    );

    return ((await replaced.json()) as { key: string }).key;
  };

  const key = async (environment: string): Promise<string> => {
    const made = keys.get(environment) ?? makeKey(environment);
    keys.set(environment, made);

    return made;
  };

  const join = async (runner: string, environment: string): Promise<string> => {
    const response = await fetch(new URL("/agent/join", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "pipoca-protocol": "4",
        authorization: `Bearer ${await key(environment)}`,
      },
      body: JSON.stringify({ name: runner }),
    });

    return ((await response.json()) as Joined).token;
  };

  return {
    key,
    token: async (runner, environment = runner) => {
      const id = `${environment}/${runner}`;
      const joined = tokens.get(id) ?? join(runner, environment);
      tokens.set(id, joined);

      return joined;
    },
  };
}
