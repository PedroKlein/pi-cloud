import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalResize } from "@pi-cloud/protocol";

export function openTerminal(
  sessionId: string,
  container: HTMLElement,
): () => void {
  const terminal = new Terminal({ cursorBlink: true });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);
  fit.fit();

  const url = new URL(`/api/sessions/${sessionId}/terminal`, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("cols", String(terminal.cols));
  url.searchParams.set("rows", String(terminal.rows));
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const encoder = new TextEncoder();

  socket.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
    terminal.write(new Uint8Array(event.data));
  });
  socket.addEventListener("close", () => {
    terminal.write("\r\n[terminal closed]\r\n");
  });
  const input = terminal.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encoder.encode(data));
    }
  });
  const resize = terminal.onResize(({ cols, rows }) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({ type: "resize", cols, rows } satisfies TerminalResize),
      );
    }
  });
  const observer = new ResizeObserver(() => {
    fit.fit();
  });
  observer.observe(container);
  terminal.focus();

  return () => {
    observer.disconnect();
    input.dispose();
    resize.dispose();
    socket.close();
    terminal.dispose();
  };
}
