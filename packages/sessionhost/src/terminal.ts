export interface TerminalOptions {
  readonly cwd: string;
  readonly variables?: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
  readonly shell?: string;
}

export interface Terminal {
  write: (data: string | Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
  readonly exited: Promise<number>;
}

// Node has no PTY API, and node-pty's resize fails under Bun with EBADF.
export function openTerminal(
  options: TerminalOptions,
  onData: (data: Uint8Array) => void,
): Terminal {
  const shell = options.shell ?? process.env["SHELL"] ?? "/bin/sh";

  const proc = Bun.spawn([shell, "-i"], {
    cwd: options.cwd,
    env: { ...process.env, ...options.variables, TERM: "xterm-256color" },
    terminal: {
      cols: options.cols,
      rows: options.rows,
      data: (_terminal, data) => {
        onData(data);
      },
    },
  });

  const { terminal } = proc;
  if (!terminal) {
    throw new Error("Bun did not attach a terminal to the shell");
  }

  return {
    write: (data) => {
      if (terminal.closed) {
        return;
      }

      terminal.write(data);
    },
    resize: (cols, rows) => {
      if (terminal.closed) {
        return;
      }

      terminal.resize(cols, rows);
    },
    close: () => {
      proc.kill();
      terminal.close();
    },
    exited: proc.exited,
  };
}
