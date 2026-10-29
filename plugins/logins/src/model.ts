import type { Credential } from "@earendil-works/pi-ai";

// What the plugin's routes send and take, shared with its Session and web
// parts.

export interface LoginView {
  readonly provider: string;
  readonly type: Credential["type"];
  readonly updatedAt: string;
}

export interface Account {
  readonly logins: readonly LoginView[];
}

// A lease on one provider's login, held while a Session reads, refreshes and
// writes it back (ADR 0045).
export interface Lease {
  readonly lease: string;
  readonly credential: Credential | null;
}

// Leaving credential out keeps the stored login, and null removes it.
export interface Release {
  readonly lease: string;
  readonly credential?: Credential | null;
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
