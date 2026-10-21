export interface Changes {
  readonly files: readonly {
    readonly status: string;
    readonly path: string;
  }[];
  readonly stat: string;
  readonly patch: string;
  readonly truncated: boolean;
}

// What one checkout of the workspace changed. name is the checkout's folder
// in a workspace of several repositories, and empty otherwise.
export interface CheckoutChanges extends Changes {
  readonly name: string;
}
