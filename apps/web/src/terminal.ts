import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalResize } from "@pi-cloud/protocol";

export function openTerminal(
  sessionId: string,
  container: HTMLElement,
  onClose: () => void,
): () => void {
  const token = (name: string): string =>
    getComputedStyle(container).getPropertyValue(name).trim();

  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: token("--font-mono"),
    fontSize: 13,
    theme: {
      background: token("--term-bg"),
      foreground: token("--term-fg"),
      cursor: token("--term-fg"),
      selectionBackground: token("--accent-tint"),
    },
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
        } satisfies TerminalResize),
      );
    }
  };

  socket.addEventListener("open", sendSize);

  const closed = (event: CloseEvent): void => {
    terminal.write(
      `\r\n[terminal closed${event.reason === "" ? "" : `: ${event.reason}`}]\r\n`,
    );

    onClose();
  };

  socket.addEventListener("close", closed);

  const input = terminal.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encoder.encode(data));
    }
  });

  const resize = terminal.onResize(sendSize);

  const observer = new ResizeObserver(() => {
    fit.fit();
  });

  observer.observe(container);
  terminal.focus();

  return () => {
    socket.removeEventListener("close", closed);
    observer.disconnect();
    input.dispose();
    resize.dispose();
    socket.close();
    terminal.dispose();
  };
}
