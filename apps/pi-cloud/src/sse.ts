const heartbeatMs = 15_000;

// A client this far behind is not keeping up. Dropping it bounds server
// memory, and it reconnects with Last-Event-ID without losing events.
const maxQueuedBytes = 1024 * 1024;

export function sseResponse(
  open: (
    send: (data: unknown, id?: string) => void,
    end: () => void,
  ) => () => void,
): Response {
  const encoder = new TextEncoder();
  let close = (): void => undefined;
  let closed = false;
  let replayed = false;

  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const write = (text: string): void => {
          if (closed) {
            return;
          }

          if (replayed && (controller.desiredSize ?? 0) < 0) {
            close();
            controller.error(new Error("client fell behind"));

            return;
          }

          controller.enqueue(encoder.encode(text));
        };

        write(": open\n\n");

        const heartbeat = setInterval(() => {
          write(": ping\n\n");
        }, heartbeatMs);

        let stop = (): void => undefined;

        close = () => {
          if (!closed) {
            closed = true;
            clearInterval(heartbeat);
            stop();
          }
        };

        stop = open(
          (data, id) => {
            const field = id === undefined ? "" : `id: ${id}\n`;
            write(`${field}data: ${JSON.stringify(data)}\n\n`);
          },
          () => {
            if (!closed) {
              close();
              controller.close();
            }
          },
        );

        replayed = true;
      },
      cancel() {
        close();
      },
    },
    { highWaterMark: maxQueuedBytes, size: (chunk) => chunk?.byteLength ?? 0 },
  );

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

export async function* readSse(
  response: Response,
  idleMs = heartbeatMs * 3,
): AsyncGenerator {
  if (!response.body) {
    return;
  }

  // A command can carry megabytes of base64 images. Searching only the new
  // chunk, and joining the parts once an event ends, keeps reading it linear.
  let pending: string[] = [];
  let lastChar = "";
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

  const idle = (): void => {
    void reader.cancel(new Error("event stream went quiet"));
  };

  let watchdog = setTimeout(idle, idleMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }

      clearTimeout(watchdog);
      watchdog = setTimeout(idle, idleMs);

      const scanned = lastChar + value;
      lastChar = scanned.slice(-1);
      pending.push(value);
      if (!scanned.includes("\n\n")) {
        continue;
      }

      let buffer = pending.join("");
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const data = buffer
          .slice(0, end)
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice("data: ".length))
          .join("\n");

        buffer = buffer.slice(end + 2);
        if (data !== "") {
          yield JSON.parse(data);
        }

        end = buffer.indexOf("\n\n");
      }

      pending = [buffer];
    }
  } finally {
    clearTimeout(watchdog);
  }
}
