// The token in the last setup link a server logged while it had no users.
export function setupTokenOf(logs: readonly string[]): string {
  const token = logs
    .map((line) => /#setup\/([\w-]+)/.exec(line)?.[1])
    .findLast((found) => found !== undefined);

  if (token === undefined) {
    throw new Error("the server logged no setup link");
  }

  return token;
}

// Creates the first user and returns the Cookie header that signs it in.
export async function firstUserCookie(
  handle: (request: Request) => Promise<Response>,
  server: string | URL,
  token: string,
): Promise<string> {
  const response = await handle(
    new Request(new URL("/api/auth/setup", server).href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, name: "pedro", password: "correct horse" }),
    }),
  );

  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (response.status !== 201 || cookie === undefined) {
    throw new Error(`setup failed: ${String(response.status)}`);
  }

  return cookie;
}

// The Cookie header of a served server's first user, created on first use.
export function firstUser(
  server: { readonly url: URL },
  logs: readonly string[],
): () => Promise<string> {
  let cookie: Promise<string> | undefined;

  return async () => {
    cookie ??= firstUserCookie(fetch, server.url, setupTokenOf(logs));

    return cookie;
  };
}
