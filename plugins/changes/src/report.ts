export interface Changes {
  readonly files: readonly {
    readonly status: string;
    readonly path: string;
  }[];
  readonly stat: string;
  readonly patch: string;
  readonly truncated: boolean;
}
