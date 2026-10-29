import type { AuthEvent, AuthType, Credential } from "@earendil-works/pi-ai";
import type { McpLoginState } from "@pipoca/plugins";

// What the plugin's routes send and take, shared with its Session and web
// parts.

export interface Stored {
  readonly key: string;
  readonly type: string;
  readonly updatedAt: string;
}

export interface Account {
  readonly logins: readonly {
    readonly provider: string;
    readonly type: Credential["type"];
    readonly updatedAt: string;
  }[];
  // Keyed as Pi keys them: the server's name, a space and its address.
  readonly mcp: readonly {
    readonly server: string;
    readonly updatedAt: string;
  }[];
  // The MCP servers of the person's Profiles that Settings signs them in to.
  readonly servers: readonly {
    readonly key: string;
    readonly name: string;
    readonly url: string;
  }[];
  // The sign-in the person started from Settings, until they dismiss it.
  readonly connection?: Connection;
}

export interface Connection {
  // The model provider, or the MCP server as Pi keys it.
  readonly key: string;
  readonly name: string;
  readonly state: "running" | "done" | "failed";
  readonly events: readonly AuthEvent[];
  readonly prompt?: ConnectionPrompt;
  readonly error?: string;
}

export interface ConnectionPrompt {
  readonly id: string;
  readonly type: "text" | "secret" | "manual_code" | "select";
  readonly message: string;
  readonly placeholder?: string;
  readonly options?: readonly { readonly id: string; readonly label: string }[];
}

// A provider that the server can sign a person in to, by the ways it takes.
export interface Connectable {
  readonly id: string;
  readonly name: string;
  readonly methods: readonly {
    readonly type: AuthType;
    readonly label: string;
  }[];
}

// A lease on one login, held while a Session reads, refreshes and writes it
// back (ADR 0045).
export interface Lease<T> {
  readonly lease: string;
  readonly value: T | null;
}

// Leaving value out keeps the stored login, and null removes it.
export interface Release<T> {
  readonly lease: string;
  readonly value?: T | null;
}

export function credentialOf(value: unknown): Credential {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    (value.type !== "api_key" && value.type !== "oauth")
  ) {
    throw new TypeError("a login must have type api_key or oauth");
  }

  return value as Credential;
}

export function mcpStateOf(value: unknown): McpLoginState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("an MCP login must be an object");
  }

  return value as McpLoginState;
}

export function mcpKey(name: string, serverUrl: string): string {
  return `${name} ${serverUrl}`;
}
