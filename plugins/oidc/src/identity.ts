export interface LinkedIdentity {
  readonly email: string | null;
  readonly linkedAt: string;
  // A user the plugin made has no password, so it can't be unlinked.
  readonly created: boolean;
}
