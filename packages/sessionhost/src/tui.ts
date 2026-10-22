import {
  type AgentSession,
  AgentSessionRuntime,
  type ExtensionFactory,
  InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import { StdinBuffer, type Terminal } from "@earendil-works/pi-tui";
import { type LiveEvent, piTerminal } from "@pi-cloud/protocol";
import type {
  Log,
  SessionStream,
  TerminalChannel,
  TerminalCommand,
} from "./host";

// The InteractiveMode members the Pi view replaces or calls. Pi keeps them
// private, and changing Pi isn't an option (ADR 0027).
interface ModeInternals {
  shutdown: () => Promise<void>;
  handleCtrlZ: () => void;
  showStatus: (message: string) => void;
  unregisterSignalHandlers: () => void;
  bindCurrentSessionExtensions: () => Promise<void>;
  readonly ui: { readonly requestRender: (force?: boolean) => void };
}

export interface PiView {
  readonly open: (command: TerminalCommand) => void;
  readonly close: () => void;
}

type Bindings = Parameters<AgentSession["bindExtensions"]>[0];

const oneSession =
  "Pi Cloud keeps one Pi session per session. Start a new session from the sidebar instead.";

// Pi's own TUI for a Session, started the first time a browser opens the Pi
// view and kept until the Session stops. Extension dialogs go to the TUI while
// a browser shows it and back to the web when none does (ADR 0027).
export function piView(
  agentDir: string,
  stream: Pick<SessionStream, "terminal">,
  publish: (event: LiveEvent) => void,
  log: Log,
): {
  // Keeps the TUI on the Session it shows, since /new, /resume, /fork, /clone
  // and /import would replace it underneath the web and the transcript
  // upload, and tells the web about dialogs open in the TUI.
  readonly extension: ExtensionFactory;
  readonly host: (session: AgentSession, web: Bindings) => PiView;
} {
  const screen = virtualTerminal();
  let tui: ModeInternals | undefined;
  let channel: TerminalChannel | undefined;
  let bound: "web" | "tui" = "web";
  let dialog: string | null = null;
  let binding = Promise.resolve();

  const announce = (): void => {
    publish({ type: "pi_view", attached: channel !== undefined, dialog });
  };

  const rebind = (to: typeof bound, bind: () => Promise<void>): void => {
    binding = binding
      .then(async () => {
        await bind();
        bound = to;
      })
      .catch((error: unknown) => {
        log("pi view failed to bind dialogs", { error: String(error) });
      });
  };

  const host = (session: AgentSession, web: Bindings): PiView => {
    const detach = (): void => {
      channel = undefined;
      screen.attach(undefined);
      rebind("web", async () => session.bindExtensions(web));
      announce();
      log("pi view detached");
    };

    const start = (): ModeInternals => {
      const runtime = new AgentSessionRuntime(
        session,
        {
          cwd: session.sessionManager.getCwd(),
          agentDir,
          modelRuntime: session.modelRuntime,
          settingsManager: session.settingsManager,
          resourceLoader: session.resourceLoader,
          diagnostics: [],
        },
        async () => Promise.reject(new Error(oneSession)),
      );

      const mode = new InteractiveMode(runtime, { terminal: screen.terminal });
      const internals = modeInternals(mode);

      internals.shutdown = async () => {
        channel?.close();
        detach();

        return Promise.resolve();
      };

      internals.handleCtrlZ = () => {
        internals.showStatus("Suspending isn't available in Pi Cloud");
      };

      const initialized = mode.init();
      internals.unregisterSignalHandlers();

      rebind("tui", async () => {
        await initialized;

        mode.run().catch((error: unknown) => {
          log("pi view stopped", { error: String(error) });
        });
      });

      return internals;
    };

    return {
      open: ({ cols, rows }) => {
        channel?.close();

        const opened = stream.terminal(piTerminal, {
          input: screen.input,
          resize: screen.resize,
          end: () => {
            opened.close();
          },
          closed: () => {
            if (channel === opened) {
              detach();
            }
          },
        });

        channel = opened;
        screen.resize(cols, rows);
        screen.attach(opened);

        if (tui === undefined) {
          tui = start();
        } else {
          const internals = tui;

          rebind("tui", async () => {
            await internals.bindCurrentSessionExtensions();
            internals.ui.requestRender(true);
          });
        }

        announce();
        log("pi view attached");
      },
      close: () => {
        channel?.close();
        channel = undefined;
      },
    };
  };

  return {
    extension: (pi) => {
      pi.on("session_before_switch", (_event, ctx) => {
        ctx.ui.notify(oneSession, "warning");

        return { cancel: true };
      });

      pi.on("session_before_fork", (_event, ctx) => {
        ctx.ui.notify(oneSession, "warning");

        return { cancel: true };
      });

      pi.on("ui_prompt_start", (event) => {
        if (bound === "tui") {
          dialog = event.title ?? event.kind;
          announce();
        }
      });

      pi.on("ui_prompt_end", () => {
        if (dialog !== null) {
          dialog = null;
          announce();
        }
      });
    },
    host,
  };
}

function modeInternals(mode: InteractiveMode): ModeInternals {
  const internals = mode as unknown as Record<string, unknown>;
  const ui = internals["ui"] as Record<string, unknown> | undefined;

  const missing = [
    "shutdown",
    "handleCtrlZ",
    "showStatus",
    "unregisterSignalHandlers",
    "bindCurrentSessionExtensions",
  ].filter((name) => typeof internals[name] !== "function");

  if (typeof ui?.["requestRender"] !== "function") {
    missing.push("ui.requestRender");
  }

  if (missing.length > 0) {
    throw new Error(
      `Pi's TUI no longer has what the Pi view needs: ${missing.join(", ")}`,
    );
  }

  return mode as unknown as ModeInternals;
}

// A terminal for Pi's TUI that draws into a socket, or nowhere while no
// browser shows it.
function virtualTerminal(): {
  readonly terminal: Terminal;
  readonly attach: (channel: TerminalChannel | undefined) => void;
  readonly input: (data: Uint8Array) => void;
  readonly resize: (cols: number, rows: number) => void;
} {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keys = new StdinBuffer();
  let columns = 80;
  let rows = 24;
  let channel: TerminalChannel | undefined;
  let onInput: (data: string) => void = () => undefined;
  let onResize: () => void = () => undefined;

  keys.on("data", (sequence) => {
    onInput(sequence);
  });

  keys.on("paste", (content) => {
    onInput(`\x1b[200~${content}\x1b[201~`);
  });

  const write = (data: string): void => {
    channel?.send(encoder.encode(data));
  };

  return {
    terminal: {
      start: (input, resized) => {
        onInput = input;
        onResize = resized;
      },
      stop: () => undefined,
      drainInput: async () => Promise.resolve(),
      write,
      get columns() {
        return columns;
      },
      get rows() {
        return rows;
      },
      kittyProtocolActive: false,
      moveBy: (lines) => {
        if (lines !== 0) {
          write(`\x1b[${String(Math.abs(lines))}${lines > 0 ? "B" : "A"}`);
        }
      },
      hideCursor: () => {
        write("\x1b[?25l");
      },
      showCursor: () => {
        write("\x1b[?25h");
      },
      clearLine: () => {
        write("\x1b[K");
      },
      clearFromCursor: () => {
        write("\x1b[J");
      },
      clearScreen: () => {
        write("\x1b[2J\x1b[H");
      },
      setTitle: () => undefined,
      setProgress: () => undefined,
      setProgramStatus: () => undefined,
    },
    attach: (next) => {
      channel = next;
    },
    input: (data) => {
      keys.process(decoder.decode(data, { stream: true }));
    },
    resize: (cols, nextRows) => {
      columns = cols;
      rows = nextRows;
      onResize();
    },
  };
}
