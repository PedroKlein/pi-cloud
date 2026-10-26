// What the plugin's routes send and take, shared with its web part.

export interface LinkedIdentity {
  readonly issuer: string;
  readonly email: string | null;
  readonly linkedAt: string;
  // A user the plugin made has no password, so it can't be unlinked.
  readonly created: boolean;
}

export interface ProviderInput {
  readonly label: string;
  readonly issuer: string;
  readonly clientId: string;
  // Never sent back. Empty keeps the current one, and null takes it away.
  readonly clientSecret: string | null;
  readonly groupsClaim: string;
  readonly accessGroup: string;
  readonly adminGroup: string;
  readonly allowedEmails: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly adminEmails: readonly string[];
}

export interface ProviderView extends Omit<ProviderInput, "clientSecret"> {
  readonly id: string;
  readonly hasClientSecret: boolean;
  // The environment variable the secret comes from, when the config file
  // names one instead of holding it sealed (ADR 0039).
  readonly clientSecretEnv: string | null;
}

export interface Account {
  readonly admin: boolean;
  // The providers, for linking an account.
  readonly providers: readonly {
    readonly id: string;
    readonly label: string;
    readonly issuer: string;
  }[];
  readonly identities: readonly LinkedIdentity[];
}
