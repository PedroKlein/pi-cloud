import { setTimeout as sleep } from "node:timers/promises";
import {
  type Assignment,
  type Command,
  type LivePost,
  protocolVersion,
  providerHeader,
  type TranscriptAck,
  type TranscriptBatch,
  versionHeader,
  type Work,
} from "@pi-cloud/protocol";
import type { ControlPlane, Log } from "@pi-cloud/providers";
import type { SessionStream } from "@pi-cloud/sessionhost";
import { readSse } from "./sse";

const reconnectMs = { initial: 500, max: 20_000 };

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
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${String(response.status)} ${await response.text()}`,
    );
  }
  return response;
}

export function httpControlPlane(agent: Agent): ControlPlane {
  return {
    work: async (signal) =>
      (await (await call(agent, "/agent/work", { signal })).json()) as Work,
  };
}

export function httpSessionStream(
  agent: Agent,
  assignment: Assignment,
  log: Log,
): SessionStream {
  const { sessionId, generation } = assignment;
  const base = `/agent/sessions/${sessionId}`;
  return {
    uploadTranscript: async (start, lines) => {
      const batch: TranscriptBatch = { generation, start, lines };
      const response = await call(agent, `${base}/transcript`, {
        method: "POST",
        body: batch,
      });
      return ((await response.json()) as TranscriptAck).acked;
    },
    publish: async (events) => {
      const post: LivePost = { generation, events };
      await call(agent, `${base}/live`, { method: "POST", body: post });
    },
    commands: (listener) => {
      const controller = new AbortController();
      void followCommands(
        agent,
        `${base}/commands?generation=${String(generation)}`,
        listener,
        log,
        controller.signal,
      );
      return () => {
        controller.abort();
      };
    },
  };
}

async function followCommands(
  agent: Agent,
  path: string,
  listener: (command: Command) => void,
  log: Log,
  signal: AbortSignal,
): Promise<void> {
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
        return;
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
}
