const heartbeatMs = 15_000;

export function sseResponse(
  open: (send: (data: unknown) => void) => () => void,
): Response {
  const encoder = new TextEncoder();
  let close = (): void => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string): void => {
        controller.enqueue(encoder.encode(text));
      };
      const heartbeat = setInterval(() => {
        write(": ping\n\n");
      }, heartbeatMs);
      const stop = open((data) => {
        write(`data: ${JSON.stringify(data)}\n\n`);
      });
      close = () => {
        clearInterval(heartbeat);
        stop();
      };
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

export async function* readSse(response: Response): AsyncGenerator {
  if (!response.body) {
    return;
  }
  let buffer = "";
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
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
}
