import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { hostTerminals } from "@pi-cloud/sessionhost";
import { httpSessionStream } from "./client";

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Stands in for a server behind a link much slower than the shell's output.
async function stalledServer(
  input: string,
): Promise<{ readonly url: string; readonly close: () => void }> {
  const sockets: Socket[] = [];

  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
    let request = "";

    socket.on("data", (chunk) => {
      request += chunk.toString("latin1");
      if (!request.includes("\r\n\r\n")) {
        return;
      }

      const key = /sec-websocket-key: *(\S+)/i.exec(request)?.[1] ?? "";

      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");

      const frame = Buffer.from([0x82, input.length, ...Buffer.from(input)]);

      socket.removeAllListeners("data");

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );

      socket.write(frame);
      socket.pause();
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () => {
      sockets.forEach((socket) => {
        socket.destroy();
      });

      server.close();
    },
  };
}

test("closes a terminal socket whose output the server stops reading", async () => {
  const server = await stalledServer("head -c 300000000 /dev/zero\n");
  const logs: string[] = [];

  const log = (message: string): void => {
    logs.push(message);
  };

  const stream = httpSessionStream(
    server.url,
    {
      token: "pct_test",
      sessionId: "s1",
      generation: 1,
      profile: { id: "profile-1", hash: "h1" },
      trusted: null,
      workspace: { kind: "folder", path: tmpdir() },
      model: null,
      thinking: null,
      systemPrompt: null,
      firstMessage: null,
      plugins: [],
      environment: {
        isolation: "process",
        image: null,
        setupScript: "",
        variables: {},
      },
    },
    log,
    () => undefined,
  );

  const terminals = hostTerminals({ cwd: tmpdir() }, stream, log);

  try {
    terminals.open({
      actor: "user:local",
      type: "terminal",
      terminalId: "t1",
      cols: 80,
      rows: 24,
    });

    await waitFor(() => logs.includes("terminal socket closed"));
  } finally {
    terminals.close();
    server.close();
  }

  expect(logs).toContain("terminal fell behind");
  expect(logs).toContain("terminal socket closed");
}, 30_000);

test("stops an attempt the server fenced without failing its live events", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ error: "stale_generation" }, { status: 409 }),
  });

  let fences = 0;

  const stream = httpSessionStream(
    server.url.href,
    {
      token: "pct_test",
      sessionId: "s1",
      generation: 1,
      profile: { id: "profile-1", hash: "h1" },
      trusted: null,
      workspace: { kind: "folder", path: tmpdir() },
      model: null,
      thinking: null,
      systemPrompt: null,
      firstMessage: null,
      plugins: [],
      environment: {
        isolation: "process",
        image: null,
        setupScript: "",
        variables: {},
      },
    },
    () => undefined,
    () => {
      fences += 1;
    },
  );

  try {
    await stream.publish([{ type: "status", status: "idle" }]);
  } finally {
    await server.stop();
  }

  expect(fences).toBe(1);
});
