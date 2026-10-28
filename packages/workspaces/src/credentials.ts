import type { GitLogin } from "@pipoca/protocol";

// The hosts a Session signs in to: its owner's connections (ADR 0043), and
// the Environment's GH_TOKEN for github.com when the owner has no login there
// (ADR 0034).
export function hostLogins(
  logins: readonly GitLogin[],
  variables: Readonly<Record<string, string>>,
): readonly GitLogin[] {
  const token = variables["GH_TOKEN"];

  return token === undefined ||
    token === "" ||
    logins.some(({ host }) => host === "github.com")
    ? logins
    : [...logins, { host: "github.com", token }];
}

// Lets git authenticate to each host over https, for clones, the Session's
// pushes and Profile packages. For each host, the empty helper first stops the
// machine's own helpers, so none answers with another login or keeps the
// token. The entries follow any the environment already has.
export function gitCredentials(
  logins: readonly GitLogin[],
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  if (logins.length === 0) {
    return {};
  }

  const count = Number(environment["GIT_CONFIG_COUNT"] ?? 0);
  const first = Number.isSafeInteger(count) && count > 0 ? count : 0;

  const entries = logins.flatMap(({ host }, index) => {
    const key = `credential.https://${host}.helper`;

    return [
      [key, ""],
      [
        key,
        `!f() { test "$1" = get && echo username=x-access-token && echo "password=$${tokenVariable(index)}"; }; f`,
      ],
    ];
  });

  const github = logins.find(({ host }) => host === "github.com");

  return {
    ...Object.fromEntries(
      logins.map(({ token }, index) => [tokenVariable(index), token]),
    ),
    ...(github && { GH_TOKEN: github.token }),
    GIT_CONFIG_COUNT: String(first + entries.length),
    ...Object.fromEntries(
      entries.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${String(first + index)}`, key],
        [`GIT_CONFIG_VALUE_${String(first + index)}`, value],
      ]),
    ),
  };
}

// gh's config folder, by file, for the hosts other than github.com, which gh
// reads from GH_TOKEN. Undefined when there are none. Without a config.yml at
// version 1, gh tries to migrate hosts.yml and asks each host who signed in.
export function ghConfig(
  logins: readonly GitLogin[],
): Readonly<Record<string, string>> | undefined {
  const enterprise = logins.filter(({ host }) => host !== "github.com");

  if (enterprise.length === 0) {
    return undefined;
  }

  return {
    "config.yml": 'version: "1"\n',
    "hosts.yml": enterprise
      .map(
        ({ host, token }) =>
          `${JSON.stringify(host)}:\n  oauth_token: ${JSON.stringify(token)}\n  git_protocol: https\n`,
      )
      .join(""),
  };
}

function tokenVariable(index: number): string {
  return `PIPOCA_GIT_TOKEN_${String(index)}`;
}
