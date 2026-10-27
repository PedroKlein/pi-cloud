import { execFileSync } from "node:child_process";
import type {
  ExtensionUIContext,
  ExtensionWidgetOptions,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type TUI,
  type Terminal,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import type { LiveEvent } from "@pipoca/protocol";
import type { Log } from "./host";

export type Surfaces = Pick<
  ExtensionUIContext,
  "setStatus" | "setWidget" | "setFooter" | "setHeader"
>;

type Placed = Component & { dispose?(): void };

type Surface =
  | {
      readonly kind: "widget";
      readonly key: string;
      readonly placement: Placement;
    }
  | { readonly kind: "footer" | "header" };

type Placement = NonNullable<ExtensionWidgetOptions["placement"]>;

export interface SurfaceContext {
  readonly cwd: () => string | undefined;
  readonly providers: () => number;
  readonly log: Log;
}

const defaultColumns = 100;
const minInterval = 250;
const maxTextLines = 10;
const branchTTL = 5000;

// Lines an extension writes for hosts to read, such as pi-subagents'
// PI_SUBAGENT_ASYNC_JSON status snapshots, not for people.
const hostPayload = /^PI_([A-Z_]+)_JSON:(.*)$/s;

const terminalCodes =
  // eslint-disable-next-line no-control-regex -- escape codes are what it matches
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

// Renders extensions' widgets, footer and header the way Pi's TUI does, and
// publishes the lines for the web (ADR 0029).
export function webSurfaces(
  publish: (event: LiveEvent) => void,
  context: SurfaceContext,
): {
  readonly ui: Surfaces;
  readonly resize: (columns: number) => void;
  readonly close: () => void;
} {
  let columns = defaultColumns;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushed = 0;
  const statuses = new Map<string, string>();
  const shown = new Map<string, { surface: Surface; component: Placed }>();
  const published = new Map<string, string>();
  const relayed = new Map<string, string>();

  // Publishes the last line a widget wrote for hosts, or that it's gone
  // (ADR 0030).
  const relay = (key: string, content: readonly string[] | undefined): void => {
    const payload = content?.flatMap(payloadOf).at(-1);

    if (payload) {
      relayed.set(key, payload.name);
      publish({ type: "extension_data", key, ...payload });

      return;
    }

    const name = relayed.get(key);

    if (name !== undefined) {
      relayed.delete(key);
      publish({ type: "extension_data", key, name, data: null });
    }
  };

  const flush = (): void => {
    timer = undefined;
    flushed = performance.now();

    for (const [id, { surface, component }] of shown) {
      let lines: string[];

      try {
        lines = component
          .render(columns)
          .map((line) => styledOnly(line).trimEnd());
      } catch (error) {
        context.log("extension surface failed to render", {
          surface: id,
          error: String(error),
        });

        continue;
      }

      const text = lines.join("\n");

      if (published.get(id) !== text) {
        published.set(id, text);
        publish(eventOf(surface, lines));
      }
    }
  };

  const schedule = (): void => {
    timer ??= setTimeout(
      flush,
      Math.max(0, minInterval - (performance.now() - flushed)),
    );
  };

  const tui = headlessTUI(() => columns, schedule);

  const show = (
    id: string,
    surface: Surface,
    component: Placed | undefined,
  ): void => {
    shown.get(id)?.component.dispose?.();

    if (component) {
      shown.set(id, { surface, component });
      schedule();

      return;
    }

    shown.delete(id);

    if (published.delete(id)) {
      publish(eventOf(surface, null));
    }
  };

  const footerData: ReadonlyFooterDataProvider = {
    getGitBranch: cachedBranch(context.cwd),
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: context.providers,
    onBranchChange: () => () => undefined,
  };

  return {
    ui: {
      setStatus: (key, text) => {
        if (text === undefined) {
          statuses.delete(key);
        } else {
          statuses.set(key, text);
        }

        publish({
          type: "extension_status",
          key,
          text: text === undefined ? null : styledOnly(text),
        });

        tui.requestRender();
      },
      setWidget: (
        key: string,
        content:
          readonly string[] | ((tui: TUI, theme: Theme) => Placed) | undefined,
        options?: ExtensionWidgetOptions,
      ) => {
        const surface: Surface = {
          kind: "widget",
          key,
          placement: options?.placement ?? "aboveEditor",
        };

        relay(key, typeof content === "function" ? undefined : content);

        show(
          `widget:${key}`,
          surface,
          typeof content === "function"
            ? content(tui, piTheme())
            : content && textWidget(content),
        );
      },
      setFooter: (factory) => {
        show(
          "footer",
          { kind: "footer" },
          factory?.(tui, piTheme(), footerData),
        );
      },
      setHeader: (factory) => {
        show("header", { kind: "header" }, factory?.(tui, piTheme()));
      },
    },
    resize: (next) => {
      if (next !== columns) {
        columns = next;
        schedule();
      }
    },
    close: () => {
      clearTimeout(timer);

      for (const { component } of shown.values()) {
        component.dispose?.();
      }

      shown.clear();
    },
  };
}

function eventOf(surface: Surface, lines: string[] | null): LiveEvent {
  return surface.kind === "widget"
    ? {
        type: "widget",
        key: surface.key,
        lines,
        placement: surface.placement,
      }
    : { type: surface.kind, lines };
}

function payloadOf(
  line: string,
): { readonly name: string; readonly data: unknown }[] {
  const [, name, json] =
    hostPayload.exec(line.replace(terminalCodes, "")) ?? [];

  if (name === undefined || json === undefined) {
    return [];
  }

  try {
    return [{ name, data: JSON.parse(json) as unknown }];
  } catch {
    return [];
  }
}

// Pi's TUI draws a text widget as padded lines, cut at ten.
function textWidget(content: readonly string[]): Placed | undefined {
  const lines = content.filter(
    (line) => !hostPayload.test(line.replace(terminalCodes, "")),
  );

  if (lines.length === 0) {
    return undefined;
  }

  const container = new Container();

  for (const line of lines.slice(0, maxTextLines)) {
    container.addChild(new Text(line, 1, 0));
  }

  if (lines.length > maxTextLines) {
    container.addChild(
      new Text(piTheme().fg("muted", "... (widget truncated)"), 1, 0),
    );
  }

  return container;
}

// Pi passes extensions the theme it keeps on globalThis, so every copy of its
// modules shares one, and doesn't export it.
function piTheme(): Theme {
  const shared = (globalThis as Record<symbol, Theme | undefined>)[
    Symbol.for("@earendil-works/pi-coding-agent:theme")
  ];

  if (shared === undefined) {
    throw new Error("Pi's theme isn't initialized");
  }

  return shared;
}

function styledOnly(line: string): string {
  return line.replace(terminalCodes, (code) =>
    code.startsWith("\x1b[") && code.endsWith("m") ? code : "",
  );
}

// A TUI that draws nowhere. Components get it to ask for a redraw.
function headlessTUI(
  columns: () => number,
  rendered: () => void,
): TuiMainScreen {
  const terminal: Terminal = {
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => Promise.resolve(),
    write: () => undefined,
    get columns() {
      return columns();
    },
    get rows() {
      return 24;
    },
    kittyProtocolActive: false,
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
    setProgramStatus: () => undefined,
  };

  return new (class extends TuiMainScreen {
    protected override doRender(): void {
      rendered();
    }
  })(terminal);
}

function cachedBranch(cwd: () => string | undefined): () => string | null {
  let branch: string | null = null;
  let checked = -Infinity;

  return () => {
    const directory = cwd();

    if (directory === undefined || performance.now() - checked < branchTTL) {
      return branch;
    }

    checked = performance.now();

    try {
      const name = execFileSync("git", ["branch", "--show-current"], {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      branch = name === "" ? "detached" : name;
    } catch {
      branch = null;
    }

    return branch;
  };
}
