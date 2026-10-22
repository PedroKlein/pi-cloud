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
  // Whether the checkout is on its own session branch, which /pr needs.
  readonly branched: boolean;
}

// Where a checkout's pull request stands, published under "pull-requests".
export type PullRequest = { readonly name: string } & (
  | { readonly status: "working" }
  | { readonly status: "open"; readonly url: string }
  | {
      readonly status: "compose";
      readonly url: string;
      readonly reason: string | null;
    }
  | { readonly status: "pushed"; readonly branch: string }
  | { readonly status: "failed"; readonly error: string }
);
