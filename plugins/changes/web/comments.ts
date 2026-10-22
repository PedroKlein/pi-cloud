export interface DiffComment {
  readonly checkout: string;
  readonly path: string;
  readonly line: number;
  // A removed line's number is from before the change.
  readonly removed: boolean;
  readonly text: string;
}

// The message that sends a review's comments to Pi, each tied to its line.
export function reviewMessage(comments: readonly DiffComment[]): string {
  const lines = comments.map(({ checkout, path, line, removed, text }) => {
    const where = checkout === "" ? path : `${checkout}/${path}`;
    const note = removed ? " (removed line)" : "";

    return `- At \`${where}:${String(line)}\`${note}: ${text.trim()}`;
  });

  return ["Comments on the diff:", "", ...lines].join("\n");
}
