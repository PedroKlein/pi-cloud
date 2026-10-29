import type { Credential } from "@earendil-works/pi-ai";
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
