import { expect, test } from "bun:test";
import { once } from "node:events";
import { connect } from "node:net";
import { readSse, sseResponse } from "./sse";

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("stops reading a stream that goes quiet", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"n":1}\n\n'));
    },
  });

  const events: unknown[] = [];
  for await (const event of readSse(new Response(body), 20)) {
    events.push(event);
  }

  expect(events).toEqual([{ n: 1 }]);
});

test("drops a client that stops reading while others keep receiving", async () => {
  const sends: ((data: unknown) => void)[] = [];
  let closed = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      sseResponse((send) => {
        sends.push(send);

        return () => {
          closed++;
        };
      }),
  });

  const stalled = connect(Number(server.url.port), "127.0.0.1");
  stalled.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
  await once(stalled, "data");
  stalled.pause();

  const healthy = readSse(await fetch(server.url));
  await waitFor(() => sends.length === 2);

  const chunk = "x".repeat(64 * 1024);
  let received = 0;

  for (let sent = 0; sent < 1024 && closed === 0; sent++) {
    sends.forEach((send) => {
      send(chunk);
    });

    await healthy.next();
    received++;
  }

  const dropped = closed;
  stalled.destroy();
  await healthy.return(undefined);
  await server.stop(true);

  expect(dropped).toBe(1);
  expect(received).toBeLessThan(1024);
});
