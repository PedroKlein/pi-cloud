import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import {
  type Command,
  type LiveEvent,
  type OpenedPage,
  type PreviewRequest,
  previewPort,
} from "@pi-cloud/protocol";

// One browser request to a preview, carried by its own socket to the server.
export interface PreviewExchange {
  readonly request: Promise<{
    readonly head: PreviewRequest;
    readonly body: Uint8Array;
  }>;
  readonly respond: (response: Response) => Promise<void>;
  // Carries a WebSocket's frames between the browser and the app.
  readonly relay: (app: WebSocket) => void;
  readonly fail: (reason: string) => void;
}

export type PreviewCommand = Extract<Command, { type: "preview" }>;

type Log = (
  message: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

export interface Pages {
  readonly open: (url: string) => void;
  readonly close: (id: string) => void;
  readonly connect: (command: PreviewCommand) => void;
  readonly stop: () => void;
}

const maxPages = 5;
const probeMs = 3000;

// The pages the Session asked to open in a browser. Only the ports of these
// pages can be previewed, and a page goes once nothing listens on its port
// (ADR 0037).
export function hostPages(
  preview: (connectionId: string) => PreviewExchange,
  publish: (event: LiveEvent) => void,
  log: Log,
): Pages {
  let pages: readonly OpenedPage[] = [];

  const set = (next: readonly OpenedPage[]): void => {
    pages = next;
    publish({ type: "pages", pages });
  };

  const probe = setInterval(() => {
    void Promise.all(
      pages.map(async ({ id, url }) => {
        const port = previewPort(url);

        return port === undefined || (await listening(new URL(url), port))
          ? undefined
          : id;
      }),
    ).then((ids) => {
      const closed = new Set(ids.filter((id) => id !== undefined));
      if (closed.size > 0) {
        set(pages.filter(({ id }) => !closed.has(id)));
      }
    });
  }, probeMs);

  return {
    open: (url) => {
      if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
        log("page not opened", { url });

        return;
      }

      log("page opened", { url });

      set(
        [
          ...pages.filter((page) => page.url !== url),
          { id: randomUUID(), url },
        ].slice(-maxPages),
      );
    },
    close: (id) => {
      set(pages.filter((page) => page.id !== id));
    },
    connect: ({ connectionId, port }) => {
      const exchange = preview(connectionId);
      const page = pages.find(({ url }) => previewPort(url) === port);
      if (page === undefined) {
        exchange.fail("the Session didn't open this port");

        return;
      }

      void forward(exchange, new URL(page.url), port).catch(
        (error: unknown) => {
          log("preview failed", { port, error: String(error) });
          exchange.fail(String(error));
        },
      );
    },
    stop: () => {
      clearInterval(probe);
    },
  };
}

// Sends the request as the app expects it from its own origin: apps such as
// dev servers refuse other Host and Origin headers, against DNS rebinding.
async function forward(
  exchange: PreviewExchange,
  page: URL,
  port: number,
): Promise<void> {
  const { head, body } = await exchange.request;
  const origin = `http://${page.hostname}:${String(port)}`;

  const headers = new Headers(
    head.headers.map(([name, value]) => [name, value]),
  );

  headers.set("host", `${page.hostname}:${String(port)}`);
  if (headers.has("origin")) {
    headers.set("origin", origin);
  }

  const referer = headers.get("referer");
  if (referer !== null && URL.canParse(referer)) {
    const { pathname, search } = new URL(referer);
    headers.set("referer", `${origin}${pathname}${search}`);
  }

  if (head.websocket === true) {
    const protocols =
      headers
        .get("sec-websocket-protocol")
        ?.split(",")
        .map((protocol) => protocol.trim()) ?? [];

    for (const name of [...headers.keys()]) {
      if (name.startsWith("sec-websocket-")) {
        headers.delete(name);
      }
    }

    exchange.relay(
      new WebSocket(`ws://${page.hostname}:${String(port)}${head.path}`, {
        headers: Object.fromEntries(headers),
        protocols,
      }),
    );

    return;
  }

  const response = await fetch(`${origin}${head.path}`, {
    method: head.method,
    headers,
    redirect: "manual",
    decompress: false,
    ...(head.method !== "GET" &&
      head.method !== "HEAD" && { body: body.slice() }),
  });

  const answer = new Headers(response.headers);
  const location = answer.get("location");
  if (location !== null && URL.canParse(location)) {
    const target = new URL(location);
    if (previewPort(target.href) === port) {
      answer.set(
        "location",
        `${target.pathname}${target.search}${target.hash}`,
      );
    }
  }

  await exchange.respond(
    new Response(response.body, { status: response.status, headers: answer }),
  );
}

async function listening(url: URL, port: number): Promise<boolean> {
  const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port });

  try {
    await once(socket, "connect");

    return true;
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}

// Points BROWSER at a script that hands each URL to the Session host, for
// Pi's tools and extensions, such as plannotator. The script runs opener with
// the URL, and opener posts it to PI_CLOUD_PAGES.
export async function browserHelper(
  dir: string,
  opener: readonly string[],
  open: (url: string) => void,
): Promise<{
  readonly variables: Readonly<Record<string, string>>;
  readonly stop: () => void;
}> {
  const token = randomBytes(16).toString("hex");

  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== `/${token}`) {
      response.writeHead(404).end();

      return;
    }

    let url = "";
    request.setEncoding("utf8");

    request.on("data", (chunk: string) => {
      url += chunk;
    });

    request.on("end", () => {
      open(url.trim());
      response.writeHead(204).end();
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const script = join(dir, "browser");
  await mkdir(dir, { recursive: true });

  await writeFile(
    script,
    `#!/bin/sh\nexec ${opener.map(quoted).join(" ")} "$@"\n`,
  );

  await chmod(script, 0o755);

  return {
    variables: {
      BROWSER: script,
      PI_CLOUD_PAGES: `http://127.0.0.1:${String(port)}/${token}`,
    },
    stop: () => {
      server.close();
    },
  };
}

function quoted(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}
