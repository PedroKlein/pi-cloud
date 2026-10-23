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
  // Binary, renamed, mode-only and empty files, which have no lines to show.
  readonly notes: readonly string[];
  readonly hunks: readonly DiffHunk[];
}

const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const escapes: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
};

// Reads a name that git may have C-quoted (core.quotePath).
function unquote(text: string): string {
  if (!text.startsWith('"')) {
    return text;
  }

  const bytes: number[] = [];
  let at = 1;

  while (at < text.length && text[at] !== '"') {
    const char = text.charAt(at);

    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      at += 1;

      continue;
    }

    const next = text.charAt(at + 1);
    const octal = /^[0-7]{3}/.exec(text.slice(at + 1));

    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      at += 4;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      at += 2;
    }
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

// The path on a ---/+++ line, where git adds a tab after a name with spaces.
function linePath(text: string): string | undefined {
  const name = unquote(text.replace(/\t$/, ""));

  return name === "/dev/null" ? undefined : name.slice(2);
}

// The path on the diff --git line, for files without ---/+++ lines such as
// binary or mode-only changes. Unquoted a and b names can only be told apart
// when they match, which holds unless the file was renamed.
function headerPath(text: string): string {
  if (text.startsWith('"')) {
    return unquote(text).slice(2);
  }

  const half = (text.length - 1) / 2;
  if (text.slice(2, half) === text.slice(half + 3)) {
    return text.slice(2, half);
  }

  return text.slice(text.lastIndexOf(" b/") + 3);
}

// Splits git's unified diff into files and hunks with line numbers.
export function parseDiff(patch: string): readonly DiffFile[] {
  const files: {
    path: string;
    extended: string[];
    hunks: { header: string; lines: DiffLine[] }[];
  }[] = [];

  let oldLine = 0;
  let newLine = 0;

  for (const line of patch.split("\n")) {
    const file = files.at(-1);
    const hunk = file?.hunks.at(-1);

    if (line.startsWith("diff --git ")) {
      files.push({ path: headerPath(line.slice(11)), extended: [], hunks: [] });

      continue;
    }

    if (file?.hunks.length === 0) {
      file.extended.push(line);

      if (line.startsWith("rename to ")) {
        file.path = unquote(line.slice(10));
      }

      if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        file.path = linePath(line.slice(4)) ?? file.path;
      }
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

  return files.map(({ path, extended, hunks }) => {
    const lines = hunks.flatMap((h) => h.lines);

    return {
      path,
      added: lines.filter(({ kind }) => kind === "add").length,
      removed: lines.filter(({ kind }) => kind === "remove").length,
      notes: notes(extended, hunks.length === 0),
      hunks,
    };
  });
}

// Describes what git's extended header lines say about a file, such as a
// binary, renamed or mode-only change that has no lines to show.
function notes(extended: readonly string[], empty: boolean): string[] {
  const value = (prefix: string): string | undefined =>
    extended.find((line) => line.startsWith(prefix))?.slice(prefix.length);

  const renamed = value("rename from ");
  const oldMode = value("old mode ");
  const newMode = value("new mode ");

  const binary = extended.some(
    (line) => line === "GIT binary patch" || line.startsWith("Binary files "),
  );

  const found: string[] = [];

  let status = "changed";
  if (value("new file mode ") !== undefined) {
    status = "added";
  }

  if (value("deleted file mode ") !== undefined) {
    status = "deleted";
  }

  if (binary) {
    found.push(`Binary file ${status}`);
  } else if (empty && status !== "changed") {
    found.push(`Empty file ${status}`);
  }

  if (renamed !== undefined) {
    found.push(`Renamed from ${unquote(renamed)}`);
  }

  if (oldMode !== undefined && newMode !== undefined) {
    found.push(`Mode changed from ${oldMode} to ${newMode}`);
  }

  return found;
}
