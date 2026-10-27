import { setTimeout as sleep } from "node:timers/promises";
import {
  type JoinRequest,
  type Joined,
  type SessionStart,
  type Command,
  type LivePost,
  type PreviewRequest,
  type ProfileFiles,
  type PreviewResponse,
  type RemovalPost,
  type StartFailure,
  type ToolCall,
  type TrustAnswer,
  type ToolSpec,
  protocolVersion,
  type TerminalControl,
  type TranscriptAck,
  type TranscriptBatch,
  versionHeader,
  type Work,
} from "@pipoca/protocol";
import type { ControlPlane, Log } from "@pipoca/providers";
import type {
  PreviewExchange,
  SessionStream,
  TerminalChannel,
  TerminalPeer,
} from "@pipoca/sessionhost";
import { readSse } from "./sse";

const reconnectMs = { initial: 500, max: 20_000 };
const pollTimeoutMs = 30_000;
const requestTimeoutMs = 30_000;

// Only a terminal's last output is replayed (ADR 0026), so a socket this far
// behind the server is closed instead of buffered without bound. The built-in
// provider shares the server's event loop, where tens of MB can queue for a
// moment while everything is healthy, so the limit sits well above that.
const maxTerminalBufferedBytes = 64 * 1024 * 1024;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// A runner's token, or one of its Sessions' (ADR 0033).
interface Agent {
  readonly server: string;
  readonly token: string;
}

function agentHeaders(agent: Agent): Record<string, string> {
  return {
    [versionHeader]: String(protocolVersion),
    authorization: `Bearer ${agent.token}`,
  };
}

// Joins the pool of the Environment the key belongs to, waiting for a server
// that isn't up yet. A key the server refuses ends the wait, and so does the
// signal, with undefined.
export async function joinPool(
  server: string,
  key: string,
  request: JoinRequest,
  log: Log,
  signal: AbortSignal,
): Promise<Joined | undefined> {
  let delayMs = reconnectMs.initial;

  while (!signal.aborted) {
    try {
      const joined = await call({ server, token: key }, "/agent/join", {
        method: "POST",
        body: request,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(requestTimeoutMs),
        ]),
      });

      return (await joined.json()) as Joined;
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        throw new Error("the server refused the Environment key", {
          cause: error,
        });
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the signal can abort while the call above is pending
      if (signal.aborted) {
        return undefined;
      }

      log("join failed", { error: String(error), retryInMs: delayMs });
    }

    await sleep(delayMs, undefined, { signal }).catch(() => undefined);
    delayMs = Math.min(delayMs * 2, reconnectMs.max);
  }

  return undefined;
}

async function call(
  agent: Agent,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<Response> {
  const response = await fetch(new URL(path, agent.server), {
    method: init.method ?? "GET",
    headers: {
      ...agentHeaders(agent),
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    ...(init.signal && { signal: init.signal }),
  });

  if (!response.ok) {
    throw new HttpError(
      response.status,
      `${init.method ?? "GET"} ${path}: ${String(response.status)} ${await response.text()}`,
    );
  }

  return response;
}

export function httpControlPlane(
  agent: Agent,
  letGo: () => void,
): ControlPlane {
  return {
    work: async (poll, signal) => {
      try {
        const response = await call(agent, "/agent/work", {
          method: "POST",
          body: poll,
          signal: AbortSignal.any([signal, AbortSignal.timeout(pollTimeoutMs)]),
        });

        return (await response.json()) as Work;
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
          letGo();
        }

        throw error;
      }
    },
  };
}

export async function reportStartFailure(
  agent: Agent,
  sessionId: string,
  failure: StartFailure,
): Promise<void> {
  await call(agent, `/agent/sessions/${sessionId}/failed`, {
    method: "POST",
    body: failure,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
}

// The server's copy of a Session's transcript, for a runner that has none
// (ADR 0032).
export async function fetchTranscript(
  agent: Agent,
  sessionId: string,
): Promise<readonly string[]> {
  const response = await call(
    agent,
    `/agent/sessions/${sessionId}/transcript`,
    {
      signal: AbortSignal.timeout(requestTimeoutMs),
    },
  );

  return ((await response.json()) as { entries: readonly string[] }).entries;
}

// An installed plugin's Session part, asked for by its bundle's hash (ADR
// 0022).
export async function fetchSessionPart(
  server: string,
  assignment: SessionStart,
  name: string,
  hash: string,
): Promise<Uint8Array> {
  const response = await call(
    { server, token: assignment.token },
    `/agent/sessions/${assignment.sessionId}/plugin-parts/${name}/${hash}`,
    { signal: AbortSignal.timeout(requestTimeoutMs) },
  );

  return new Uint8Array(await response.arrayBuffer());
}

// The files of an assigned Session's Profile (ADR 0041).
export async function fetchProfile(
  server: string,
  assignment: SessionStart,
): Promise<ProfileFiles> {
  const response = await call(
    { server, token: assignment.token },
    `/agent/sessions/${assignment.sessionId}/profile`,
    { signal: AbortSignal.timeout(requestTimeoutMs) },
  );

  return (await response.json()) as ProfileFiles;
}

export async function reportRemoval(
  agent: Agent,
  sessionId: string,
  report: RemovalPost,
): Promise<void> {
  await call(agent, `/agent/sessions/${sessionId}/workspace`, {
    method: "POST",
    body: report,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
}

export function httpSessionStream(
  server: string,
  assignment: SessionStart,
  log: Log,
  fenced: () => void,
): SessionStream {
  const { sessionId, generation } = assignment;
  const agent = { server, token: assignment.token };
  const base = `/agent/sessions/${sessionId}`;

  const post = async (path: string, body: unknown): Promise<Response> => {
    try {
      return await call(agent, `${base}/${path}`, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      if (rejected(error)) {
        fenced();
      }

      throw error;
    }
  };

  return {
    uploadTranscript: async (start, lines) => {
      const batch: TranscriptBatch = { generation, start, lines };
      const response = await post("transcript", batch);

      return ((await response.json()) as TranscriptAck).acked;
    },
    // No one follows a fenced attempt live, such as one whose Session was
    // just archived, so its events are dropped without a retry.
    publish: async (events) => {
      const live: LivePost = { generation, events };

      await post("live", live).catch((error: unknown) => {
        if (!rejected(error)) {
          throw error;
        }
      });
    },
    commands: (listener) => {
      const controller = new AbortController();

      void followCommands(
        agent,
        `${base}/commands?generation=${String(generation)}`,
        listener,
        log,
        controller.signal,
      ).then((stoppedByServer) => {
        if (stoppedByServer) {
          fenced();
        }
      });

      return () => {
        controller.abort();
      };
    },
    tools: async () =>
      (await (
        await call(agent, `${base}/tools?generation=${String(generation)}`, {
          signal: AbortSignal.timeout(requestTimeoutMs),
        })
      ).json()) as ToolSpec[],
    callTool: async (id, name, input) => {
      const toolCall: ToolCall = { generation, id, name, input };
      await post("tool-calls", toolCall);
    },
    answerTrust: async (trusted) => {
      const answer: TrustAnswer = { generation, trusted };
      await post("trust", answer);
    },
    pluginRequest: async (plugin, path, init = {}) => {
      const url = new URL(`${base}/plugins/${plugin}/${path}`, agent.server);
      url.searchParams.set("generation", String(generation));

      const headers = new Headers(init.headers);
      for (const [name, value] of Object.entries(agentHeaders(agent))) {
        headers.set(name, value);
      }

      return fetch(url, { ...init, headers });
    },
    terminal: (terminalId, peer) =>
      openTerminalSocket(
        agent,
        `${base}/terminals/${terminalId}?generation=${String(generation)}`,
        peer,
        log,
      ),
    preview: (connectionId) =>
      openPreviewSocket(
        agent,
        `${base}/previews/${connectionId}?generation=${String(generation)}`,
      ),
  };
}

// A slow browser makes the Session host wait instead of buffering a whole
// download.
const maxPreviewBufferedBytes = 1024 * 1024;

function openPreviewSocket(agent: Agent, path: string): PreviewExchange {
  const url = new URL(path, agent.server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const socket = new WebSocket(url, { headers: agentHeaders(agent) });
  socket.binaryType = "arraybuffer";

  const opened = new Promise((resolve) => {
    socket.addEventListener("open", resolve, { once: true });
  });

  // A WebSocket's frames from the browser, once the request has arrived.
  let relayed: WebSocket | undefined;

  const request = new Promise<{
    readonly head: PreviewRequest;
    readonly body: Uint8Array;
  }>((resolve, reject) => {
    let head: PreviewRequest | undefined;
    let received = false;

    socket.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as string | ArrayBuffer;
      if (received) {
        relayed?.send(data);
      } else if (typeof data === "string") {
        head = JSON.parse(data) as PreviewRequest;
      } else if (head !== undefined) {
        received = true;
        resolve({ head, body: new Uint8Array(data) });
      }
    });

    socket.addEventListener("close", () => {
      reject(new Error("the preview socket closed"));
    });
  });

  request.catch(() => undefined);

  return {
    request,
    respond: async (response) => {
      const head: PreviewResponse = {
        status: response.status,
        headers: [...response.headers],
      };

      socket.send(JSON.stringify(head));
      if (response.body === null) {
        socket.close(1000);

        return;
      }

      const chunks: AsyncIterable<Uint8Array> = response.body;
      for await (const chunk of chunks) {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }

        socket.send(chunk);
        while (socket.bufferedAmount > maxPreviewBufferedBytes) {
          await sleep(10);
        }
      }

      socket.close(1000);
    },
    relay: (app) => {
      app.binaryType = "arraybuffer";

      app.addEventListener("open", () => {
        relayed = app;
        const head: PreviewResponse = { status: 101, headers: [] };
        socket.send(JSON.stringify(head));
      });

      app.addEventListener("message", (event: MessageEvent) => {
        socket.send(event.data as string | ArrayBuffer);
      });

      app.addEventListener("close", (event) => {
        socket.close(
          relayed === undefined ? 1011 : 1000,
          relayed === undefined
            ? "the app refused the WebSocket"
            : event.reason,
        );
      });

      socket.addEventListener("close", () => {
        app.close();
      });
    },
    fail: (reason) => {
      void opened.then(() => {
        socket.close(1011, reason.slice(0, 120));
      });
    },
  };
}

function openTerminalSocket(
  agent: Agent,
  path: string,
  peer: TerminalPeer,
  log: Log,
): TerminalChannel {
  const url = new URL(path, agent.server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const socket = new WebSocket(url, {
    headers: agentHeaders(agent),
  });

  socket.binaryType = "arraybuffer";
  const pending: Uint8Array[] = [];

  socket.addEventListener("open", () => {
    for (const data of pending.splice(0)) {
      socket.send(data);
    }
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    if (event.data instanceof ArrayBuffer) {
      peer.input(new Uint8Array(event.data));

      return;
    }

    const control = JSON.parse(String(event.data)) as TerminalControl;
    if (control.type === "close") {
      peer.end();
    } else {
      peer.resize(control.cols, control.rows);
    }
  });

  socket.addEventListener("close", (event) => {
    log("terminal socket closed", {
      path,
      code: event.code,
      reason: event.reason,
    });

    peer.closed();
  });

  return {
    send: (data) => {
      if (socket.readyState === WebSocket.CONNECTING) {
        pending.push(data);
      } else if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);

        if (socket.bufferedAmount > maxTerminalBufferedBytes) {
          log("terminal fell behind", {
            path,
            bufferedAmount: socket.bufferedAmount,
          });

          socket.terminate();
        }
      }
    },
    close: () => {
      socket.close();
    },
  };
}

function rejected(error: unknown): boolean {
  return (
    error instanceof HttpError && (error.status === 404 || error.status === 409)
  );
}

async function followCommands(
  agent: Agent,
  path: string,
  listener: (command: Command) => void,
  log: Log,
  signal: AbortSignal,
): Promise<boolean> {
  let delayMs = reconnectMs.initial;
  while (!signal.aborted) {
    try {
      const response = await call(agent, path, { signal });
      delayMs = reconnectMs.initial;
      for await (const command of readSse(response)) {
        listener(command as Command);
      }
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the signal can abort while the await above is pending
      if (signal.aborted) {
        return false;
      }

      if (rejected(error)) {
        log("command stream rejected", { path, error: String(error) });

        return true;
      }

      log("command stream failed", {
        path,
        error: String(error),
        retryInMs: delayMs,
      });
    }

    await sleep(delayMs, undefined, { signal }).catch(() => undefined);
    delayMs = Math.min(delayMs * 2, reconnectMs.max);
  }

  return false;
}
