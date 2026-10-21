export interface DiffLine {
  readonly kind: "add" | "remove" | "context" | "note";
  readonly text: string;
  readonly oldLine: number | undefined;
  readonly newLine: number | undefined;
}

export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export interface DiffFile {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly hunks: readonly DiffHunk[];
}

const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Splits git's unified diff into files and hunks with line numbers.
export function parseDiff(patch: string): readonly DiffFile[] {
  const files: {
    path: string;
    hunks: { header: string; lines: DiffLine[] }[];
  }[] = [];

  let oldLine = 0;
  let newLine = 0;

  for (const line of patch.split("\n")) {
    const file = files.at(-1);
    const hunk = file?.hunks.at(-1);

    if (line.startsWith("diff --git ")) {
      files.push({
        path: line.replace(/^diff --git a\/.* b\//, ""),
        hunks: [],
      });

      continue;
    }

    const header = hunkHeader.exec(line);
    if (file && header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      file.hunks.push({ header: line, lines: [] });

      continue;
    }

    if (!hunk) {
      continue;
    }

    const text = line.slice(1);

    switch (line.charAt(0)) {
      case "+":
        hunk.lines.push({ kind: "add", text, oldLine: undefined, newLine });
        newLine += 1;

        break;
      case "-":
        hunk.lines.push({ kind: "remove", text, oldLine, newLine: undefined });
        oldLine += 1;

        break;
      case " ":
        hunk.lines.push({ kind: "context", text, oldLine, newLine });
        oldLine += 1;
        newLine += 1;

        break;
      case "\\":
        hunk.lines.push({
          kind: "note",
          text: line.slice(2),
          oldLine: undefined,
          newLine: undefined,
        });

        break;
      default:
        break;
    }
  }

  return files.map(({ path, hunks }) => {
    const lines = hunks.flatMap((h) => h.lines);

    return {
      path,
      added: lines.filter(({ kind }) => kind === "add").length,
      removed: lines.filter(({ kind }) => kind === "remove").length,
      hunks,
    };
  });
}
