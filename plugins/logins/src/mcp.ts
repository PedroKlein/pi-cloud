import {
  authorizeMcp,
  McpOAuthProvider,
  type McpOAuthState,
  type McpOAuthStateStore,
} from "@earendil-works/pi-mcp/oauth";
import type { ProfileMcpServer } from "@pipoca/plugins";
import type { SignIn } from "./connect";
import { mcpKey } from "./model";

// An MCP server that signs people in with OAuth, as a Profile's mcp.json
// configures it.
export interface McpServer {
  readonly key: string;
  readonly name: string;
  readonly url: string;
  readonly clientId?: string;
  readonly clientName?: string;
  readonly scope?: string;
  readonly authServerMetadataUrl?: string;
  // The loopback address registered for clientId. The person pastes the
  // address they land on, since nothing listens there.
  readonly loopback?: string;
}

export interface AuthorizationResponse {
  readonly code: string;
  readonly iss?: string;
}

// Settings signs people in to the servers Pi would sign in to with OAuth:
// those with an address and without their own credentials. A client secret
// may name a command or a variable of the runner, and Pi's metadata document
// lists loopback addresses only, so those servers take /mcp login in a
// Session.
export function signableServers(
  listed: readonly ProfileMcpServer[],
): readonly McpServer[] {
  const servers = new Map<string, McpServer>();

  for (const { name, config } of listed) {
    const server = signable(name, config);

    if (server !== undefined && !servers.has(server.key)) {
      servers.set(server.key, server);
    }
  }

  return [...servers.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function signable(name: string, config: unknown): McpServer | undefined {
  if (!isRecord(config) || typeof config["url"] !== "string") {
    return undefined;
  }

  const headers = isRecord(config["headers"]) ? config["headers"] : {};
  const oauth = isRecord(config["oauth"]) ? config["oauth"] : {};

  if (
    config["enabled"] === false ||
    config["auth"] !== undefined ||
    Object.keys(headers).some(
      (header) => header.toLowerCase() === "authorization",
    ) ||
    oauth["clientSecret"] !== undefined ||
    oauth["clientRegistration"] === "cimd"
  ) {
    return undefined;
  }

  const clientId = text(oauth["clientId"]);
  const loopback = clientId === undefined ? undefined : loopbackOf(oauth);

  if (clientId !== undefined && loopback === undefined) {
    return undefined;
  }

  return {
    key: mcpKey(name, config["url"]),
    name,
    url: config["url"],
    ...optional("clientId", clientId),
    ...optional("clientName", text(oauth["clientName"])),
    ...optional("scope", text(oauth["scope"])),
    ...optional("authServerMetadataUrl", text(oauth["authServerMetadataUrl"])),
    ...optional("loopback", loopback),
  };
}

// The redirect address Pi registers for a client id: callbackUrl as written
// when it has a port, or 127.0.0.1 on callbackPort.
function loopbackOf(
  oauth: Readonly<Record<string, unknown>>,
): string | undefined {
  const written = text(oauth["callbackUrl"]);
  const port = oauth["callbackPort"];
  const url = new URL(written ?? "http://127.0.0.1/callback");

  if (url.port !== "") {
    return written;
  }

  if (typeof port !== "number") {
    return undefined;
  }

  url.port = String(port);

  return url.href;
}

// Signs the person in to the server like Pi's /mcp login, except that the
// sign-in page sends them back to Pipoca, which hands the response to
// responded. A client registered for a loopback address gets the address
// pasted instead.
export function mcpSignIn(
  server: McpServer,
  store: McpOAuthStateStore,
  callbackUrl: string,
  responded: (
    state: string,
    signal: AbortSignal,
  ) => Promise<AuthorizationResponse>,
): SignIn {
  return async (interaction) => {
    const signal = interaction.signal ?? new AbortController().signal;
    const redirectUrl = server.loopback ?? callbackUrl;

    await forget(store, redirectUrl, server.clientId !== undefined);

    let authorizationUrl: URL | undefined;

    const provider = new McpOAuthProvider({
      serverUrl: server.url,
      redirectUrl,
      clientMetadata: { client_name: server.clientName ?? "Pipoca" },
      ...(server.clientId !== undefined && { clientId: server.clientId }),
      store,
      onRedirect: (url) => {
        authorizationUrl = url;
      },
    });

    const flow = {
      serverUrl: server.url,
      signal,
      ...(server.scope !== undefined && { scope: server.scope }),
      ...(server.authServerMetadataUrl !== undefined && {
        authorizationServerMetadataUrl: new URL(server.authServerMetadataUrl),
      }),
    };

    if ((await authorizeMcp(provider, flow)) === "AUTHORIZED") {
      return;
    }

    if (authorizationUrl === undefined) {
      throw new Error("The MCP server gave no sign-in page");
    }

    const state = await provider.state();

    interaction.notify({ type: "auth_url", url: authorizationUrl.href });

    const { code, iss } =
      server.loopback === undefined
        ? await responded(state, signal)
        : responseOf(
            await interaction.prompt({
              type: "manual_code",
              message:
                "After you sign in, paste the address your browser lands on",
              placeholder: server.loopback,
              signal,
            }),
            state,
          );

    await authorizeMcp(provider, {
      ...flow,
      authorizationCode: code,
      ...(iss !== undefined && { iss }),
    });
  };
}

// Every sign-in gets a fresh state, and a client registered for another
// redirect address can't use this one, nor its tokens, as Pi does.
async function forget(
  store: McpOAuthStateStore,
  redirectUrl: string,
  configuredClient: boolean,
): Promise<void> {
  const stored = await store.load();
  if (stored === undefined) {
    return;
  }

  const { oauthState: _state, ...next } = stored;
  const client = stored.clientInformation;

  const registered =
    client !== undefined && "redirect_uris" in client
      ? client.redirect_uris
      : [];

  if (configuredClient || registered.includes(redirectUrl)) {
    await store.save(next);

    return;
  }

  const {
    clientInformation: _client,
    tokens: _tokens,
    tokensExpireAt: _expires,
    ...unregistered
  } = next;

  await store.save(unregistered);
}

// Reads the authorization response from the address the browser landed on.
export function responseOf(
  address: string,
  state: string,
): AuthorizationResponse {
  let params: URLSearchParams;
  try {
    params = new URL(address.trim()).searchParams;
  } catch {
    throw new Error("That isn't the address the sign-in page sent you to");
  }

  const error = params.get("error");
  if (error !== null) {
    throw new Error(
      `The MCP server refused the sign-in: ${params.get("error_description") ?? error}`,
    );
  }

  const code = params.get("code");
  if (params.get("state") !== state || code === null) {
    throw new Error("That address is from another sign-in");
  }

  const iss = params.get("iss");

  return { code, ...(iss !== null && { iss }) };
}

export type { McpOAuthState, McpOAuthStateStore };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
