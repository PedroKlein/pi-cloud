const heartbeatMs = 15_000;

export function sseResponse(
  open: (
    send: (data: unknown, id?: string) => void,
    end: () => void,
  ) => () => void,
): Response {
  const encoder = new TextEncoder();
  let close = (): void => undefined;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string): void => {
        controller.enqueue(encoder.encode(text));
      };

      write(": open\n\n");

      const heartbeat = setInterval(() => {
        write(": ping\n\n");
      }, heartbeatMs);

      let stop = (): void => undefined;

      close = () => {
        clearInterval(heartbeat);
        stop();
      };

      stop = open(
        (data, id) => {
          const field = id === undefined ? "" : `id: ${id}\n`;
          write(`${field}data: ${JSON.stringify(data)}\n\n`);
        },
        () => {
          close();
          controller.close();
        },
      );
    },
    cancel() {
      close();
    },
  });

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

  let buffer = "";
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
      buffer += value;
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
    }
  } finally {
    clearTimeout(watchdog);
  }
}
