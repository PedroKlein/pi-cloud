import { expect, test } from "bun:test";
import { readSse } from "./sse";

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
