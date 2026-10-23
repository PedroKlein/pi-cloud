export type Modifier = "ctrl" | "alt";

// The keys a phone keyboard lacks, as the bytes a terminal expects.
export const keyBar: readonly {
  readonly label: string;
  readonly data: string;
}[] = [
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "^C", data: "\x03" },
  { label: "←", data: "\x1b[D" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "→", data: "\x1b[C" },
];

// Ctrl turns a letter into its control code; Alt sends Escape first. Arrow
// keys carry the modifier as a parameter, as xterm sends them.
export function modified(data: string, modifier: Modifier | undefined): string {
  const arrow = data.slice(2);

  if (
    modifier !== undefined &&
    data.startsWith("\x1b[") &&
    ["A", "B", "C", "D"].includes(arrow)
  ) {
    return `\x1b[1;${modifier === "alt" ? "3" : "5"}${arrow}`;
  }

  if (modifier === "alt") {
    return `\x1b${data}`;
  }

  const code = data.toUpperCase().charCodeAt(0);

  return modifier === "ctrl" && data.length === 1 && code >= 64 && code <= 95
    ? String.fromCharCode(code - 64)
    : data;
}
