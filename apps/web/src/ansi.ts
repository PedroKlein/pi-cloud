// Text an extension styled for Pi's TUI, split into runs of one style
// (ADR 0028).
export interface Run {
  readonly text: string;
  readonly style: TextStyle;
}

export interface TextStyle {
  readonly fg?: string;
  readonly bg?: string;
  readonly bold?: true;
  readonly dim?: true;
  readonly italic?: true;
  readonly underline?: true;
  readonly strike?: true;
  readonly inverse?: true;
}

// xterm.js's default colours, which the Pi view's terminal uses too.
const basic = [
  "#2e3436",
  "#cc0000",
  "#4e9a06",
  "#c4a000",
  "#3465a4",
  "#75507b",
  "#06989a",
  "#d3d7cf",
  "#555753",
  "#ef2929",
  "#8ae234",
  "#fce94f",
  "#729fcf",
  "#ad7fa8",
  "#34e2e2",
  "#eeeeec",
];

const cube = [0, 95, 135, 175, 215, 255];

const terminalCodes =
  // eslint-disable-next-line no-control-regex -- escape codes are what it matches
  /\x1b\[([0-?]*)([ -/]*[@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function ansiRuns(text: string): readonly Run[] {
  const runs: Run[] = [];
  let style: TextStyle = {};
  let from = 0;

  const add = (to: number): void => {
    if (to > from) {
      runs.push({ text: text.slice(from, to), style });
    }
  };

  for (const match of text.matchAll(terminalCodes)) {
    add(match.index);
    from = match.index + match[0].length;

    if (match[2] === "m") {
      style = styled(style, match[1] ?? "");
    }
  }

  add(text.length);

  return runs;
}

function styled(current: TextStyle, parameters: string): TextStyle {
  const codes = parameters.split(";").map((code) => Number(code || "0"));
  let style: Record<string, string | true | undefined> = { ...current };

  for (let index = 0; index < codes.length; index++) {
    const code = codes[index] ?? 0;

    if (code === 38 || code === 48) {
      const [colour, used] = extended(codes.slice(index + 1));
      style[code === 38 ? "fg" : "bg"] = colour;
      index += used;
    } else if (code === 0) {
      style = {};
    } else {
      Object.assign(style, effects.get(code) ?? colours(code));
    }
  }

  return Object.fromEntries(
    Object.entries(style).filter(([, value]) => value !== undefined),
  );
}

const effects = new Map<number, Record<string, true | undefined>>([
  [1, { bold: true }],
  [2, { dim: true }],
  [3, { italic: true }],
  [4, { underline: true }],
  [7, { inverse: true }],
  [9, { strike: true }],
  [21, { bold: undefined }],
  [22, { bold: undefined, dim: undefined }],
  [23, { italic: undefined }],
  [24, { underline: undefined }],
  [27, { inverse: undefined }],
  [29, { strike: undefined }],
]);

function colours(code: number): Record<string, string | undefined> {
  if (code >= 30 && code <= 37) {
    return { fg: basic[code - 30] };
  }

  if (code >= 90 && code <= 97) {
    return { fg: basic[code - 82] };
  }

  if (code >= 40 && code <= 47) {
    return { bg: basic[code - 40] };
  }

  if (code >= 100 && code <= 107) {
    return { bg: basic[code - 92] };
  }

  if (code === 39) {
    return { fg: undefined };
  }

  if (code === 49) {
    return { bg: undefined };
  }

  return {};
}

// 38;5;n picks from the 256-colour palette, 38;2;r;g;b sets the colour.
function extended(codes: readonly number[]): [string | undefined, number] {
  if (codes[0] === 5) {
    return [indexed(codes[1] ?? 0), 2];
  }

  if (codes[0] === 2) {
    return [rgb(codes[1] ?? 0, codes[2] ?? 0, codes[3] ?? 0), 4];
  }

  return [undefined, 0];
}

function indexed(n: number): string | undefined {
  if (n < 16) {
    return basic[n];
  }

  if (n < 232) {
    const i = n - 16;

    return rgb(
      cube[Math.floor(i / 36)] ?? 0,
      cube[Math.floor(i / 6) % 6] ?? 0,
      cube[i % 6] ?? 0,
    );
  }

  const grey = 8 + (n - 232) * 10;

  return rgb(grey, grey, grey);
}

function rgb(r: number, g: number, b: number): string {
  return `rgb(${String(r)} ${String(g)} ${String(b)})`;
}
