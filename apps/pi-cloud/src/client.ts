import { setTimeout as sleep } from "node:timers/promises";
import {
  type Assignment,
  type Command,
  type LivePost,
  type RemovalPost,
  type StartFailure,
  type ToolCall,
  type TrustAnswer,
  type ToolSpec,
  protocolVersion,
  type TerminalControl,
  providerHeader,
  type TranscriptAck,
  type TranscriptBatch,
  versionHeader,
  type Work,
} from "@pi-cloud/protocol";
import type { ControlPlane, Log } from "@pi-cloud/providers";
import type {
  SessionStream,
  TerminalChannel,
  TerminalPeer,
} from "@pi-cloud/sessionhost";
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

interface Agent {
  readonly server: string;
  readonly provider: string;
}

async function call(
  agent: Agent,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<Response> {
  const response = await fetch(new URL(path, agent.server), {
    method: init.method ?? "GET",
    headers: {
      [versionHeader]: String(protocolVersion),
      [providerHeader]: agent.provider,
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

export function httpControlPlane(agent: Agent): ControlPlane {
  return {
    work: async (poll, signal) =>
      (await (
        await call(agent, "/agent/work", {
          method: "POST",
          body: poll,
          signal: AbortSignal.any([signal, AbortSignal.timeout(pollTimeoutMs)]),
        })
      ).json()) as Work,
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
  agent: Agent,
  assignment: Assignment,
  log: Log,
  fenced: () => void,
): SessionStream {
  const { sessionId, generation } = assignment;
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
      headers.set(versionHeader, String(protocolVersion));
      headers.set(providerHeader, agent.provider);

      return fetch(url, { ...init, headers });
    },
    terminal: (terminalId, peer) =>
      openTerminalSocket(
        agent,
        `${base}/terminals/${terminalId}?generation=${String(generation)}`,
        peer,
        log,
      ),
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
    headers: {
      [versionHeader]: String(protocolVersion),
      [providerHeader]: agent.provider,
    },
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
