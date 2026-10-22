import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalControl } from "@pi-cloud/protocol";

export function openTerminal(
  sessionId: string,
  terminalId: string,
  container: HTMLElement,
  typed: (data: string) => string,
  onClosed: () => void = () => undefined,
): {
  readonly send: (data: string) => void;
  // Leaves the shell running for the next socket.
  readonly close: () => void;
  // Ends the shell, as closing its tab does.
  readonly end: () => void;
} {
  const token = (name: string): string =>
    getComputedStyle(container).getPropertyValue(name).trim();

  const colours = () => ({
    background: token("--term-bg"),
    foreground: token("--term-fg"),
    cursor: token("--term-fg"),
    selectionBackground: token("--accent-tint"),
  });

  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: token("--font-mono"),
    fontSize: 13,
    theme: colours(),
  });

  const themeChanges = new MutationObserver(() => {
    terminal.options.theme = colours();
  });

  themeChanges.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);
  fit.fit();

  const url = new URL(
    `/api/sessions/${encodeURIComponent(sessionId)}/terminal`,
    location.href,
  );

  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("cols", String(terminal.cols));
  url.searchParams.set("rows", String(terminal.rows));
  url.searchParams.set("terminal", terminalId);
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const encoder = new TextEncoder();

  socket.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
    terminal.write(new Uint8Array(event.data));
  });

  const sendSize = (): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "resize",
          cols: terminal.cols,
          rows: terminal.rows,
        } satisfies TerminalControl),
      );
    }
  };

  socket.addEventListener("open", sendSize);

  const closed = (event: CloseEvent): void => {
    terminal.write(
      `\r\n[terminal closed${event.reason === "" ? "" : `: ${event.reason}`}]\r\n`,
    );

    onClosed();
  };

  socket.addEventListener("close", closed);

  const send = (data: string): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encoder.encode(data));
    }
  };

  const input = terminal.onData((data) => {
    send(typed(data));
  });

  const resize = terminal.onResize(sendSize);

  const observer = new ResizeObserver(() => {
    fit.fit();
  });

  observer.observe(container);
  terminal.focus();

  const close = (): void => {
    socket.removeEventListener("close", closed);
    observer.disconnect();
    input.dispose();
    resize.dispose();
    socket.close();
    themeChanges.disconnect();
    terminal.dispose();
  };

  return {
    send: (data) => {
      send(data);
      terminal.focus();
    },
    close,
    end: () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ type: "close" } satisfies TerminalControl),
        );
      }

      close();
    },
  };
}
