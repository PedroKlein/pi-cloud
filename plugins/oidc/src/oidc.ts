import { createHash, randomBytes } from "node:crypto";

export interface Provider {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

export interface Client {
  readonly id: string;
  // Undefined for a public client, which PKCE alone protects.
  readonly secret: string | undefined;
}

// What the plugin keeps between sending a browser to the provider and its
// way back.
export interface Attempt {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
}

export interface Identity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
  readonly groups: readonly string[];
}

export class LoginFailed extends Error {}

// OpenID Connect Discovery 1.0, section 4.
export async function discover(issuer: string): Promise<Provider> {
  const base = issuer.replace(/\/+$/, "");
  checkSecure(base);

  const response = await fetch(`${base}/.well-known/openid-configuration`);
  if (!response.ok) {
    throw new LoginFailed(
      `discovery at ${base} answered ${String(response.status)}`,
    );
  }

  const found = (await response.json()) as Record<string, unknown>;
  const authorization = found["authorization_endpoint"];
  const token = found["token_endpoint"];

  if (
    found["issuer"] !== base ||
    typeof authorization !== "string" ||
    typeof token !== "string"
  ) {
    throw new LoginFailed(`discovery at ${base} isn't for issuer ${base}`);
  }

  checkSecure(token);

  return {
    issuer: base,
    authorizationEndpoint: authorization,
    tokenEndpoint: token,
  };
}

export function newAttempt(): Attempt {
  return {
    state: randomText(),
    nonce: randomText(),
    verifier: randomText(),
  };
}

export function authorizationUrl(
  provider: Provider,
  client: Client,
  redirectUri: string,
  attempt: Attempt,
): string {
  const url = new URL(provider.authorizationEndpoint);

  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.id,
    redirect_uri: redirectUri,
    scope: "openid email profile",
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge: createHash("sha256")
      .update(attempt.verifier)
      .digest("base64url"),
    code_challenge_method: "S256",
  }).toString();

  return url.toString();
}

// The ID token comes straight from the token endpoint over TLS, so its
// signature needn't be checked (OpenID Connect Core 1.0, section 3.1.3.7).
export async function redeem(
  provider: Provider,
  client: Client,
  redirectUri: string,
  attempt: Attempt,
  code: string,
): Promise<Identity> {
  const response = await fetch(provider.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      ...(client.secret !== undefined && {
        authorization: `Basic ${basicCredentials(client)}`,
      }),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: attempt.verifier,
      ...(client.secret === undefined && { client_id: client.id }),
    }),
  });

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  const idToken = body["id_token"];

  if (!response.ok || typeof idToken !== "string") {
    throw new LoginFailed(
      `the token endpoint answered ${String(response.status)}: ${typeof body["error"] === "string" ? body["error"] : "no ID token"}`,
    );
  }

  return identityOf(claimsOf(idToken), provider, client, attempt);
}

function identityOf(
  claims: Record<string, unknown>,
  provider: Provider,
  client: Client,
  attempt: Attempt,
): Identity {
  const { iss, sub, aud, azp, exp, nonce, email, groups } = claims;
  const audiences = Array.isArray(aud) ? aud : [aud];

  if (iss !== provider.issuer) {
    throw new LoginFailed(`the ID token is from ${String(iss)}`);
  }

  if (
    !audiences.includes(client.id) ||
    (audiences.length > 1 && azp !== client.id)
  ) {
    throw new LoginFailed("the ID token is for another client");
  }

  if (typeof exp !== "number" || exp * 1000 < Date.now()) {
    throw new LoginFailed("the ID token has expired");
  }

  if (nonce !== attempt.nonce) {
    throw new LoginFailed("the ID token is for another sign-in");
  }

  if (typeof sub !== "string" || sub === "") {
    throw new LoginFailed("the ID token names no subject");
  }

  return {
    issuer: provider.issuer,
    subject: sub,
    email: typeof email === "string" ? email : null,
    groups: (Array.isArray(groups) ? groups : [groups]).filter(
      (group): group is string => typeof group === "string",
    ),
  };
}

function claimsOf(idToken: string): Record<string, unknown> {
  const payload = idToken.split(".")[1];

  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload ?? "", "base64url").toString(),
    );

    if (typeof claims === "object" && claims !== null) {
      return claims as Record<string, unknown>;
    }
  } catch {
    // Reported below like any other unreadable token.
  }

  throw new LoginFailed("the ID token can't be read");
}

// RFC 6749, section 2.3.1: both parts are form-encoded first.
function basicCredentials({ id, secret }: Client): string {
  const encode = (text: string): string =>
    encodeURIComponent(text).replace(/%20/g, "+");

  return Buffer.from(`${encode(id)}:${encode(secret ?? "")}`).toString(
    "base64",
  );
}

// Skipping the ID token's signature check relies on TLS.
function checkSecure(url: string): void {
  const { protocol, hostname } = new URL(url);

  if (
    protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(hostname)
  ) {
    throw new LoginFailed(`${url} isn't HTTPS`);
  }
}

function randomText(): string {
  return randomBytes(32).toString("base64url");
}
