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

// Ctrl turns a letter into its control code; Alt sends Escape first.
export function modified(data: string, modifier: Modifier | undefined): string {
  if (modifier === "alt") {
    return `\x1b${data}`;
  }

  const code = data.toUpperCase().charCodeAt(0);

  return modifier === "ctrl" && data.length === 1 && code >= 64 && code <= 95
    ? String.fromCharCode(code - 64)
    : data;
}
