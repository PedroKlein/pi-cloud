import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { Command, LiveEvent } from "@pi-cloud/protocol";
import { type SessionOptions, startSession } from "./session";

export interface SessionStream {
  uploadTranscript: (
    start: number,
    lines: readonly string[],
  ) => Promise<number>;
  publish: (events: readonly LiveEvent[]) => Promise<void>;
  commands: (listener: (command: Command) => void) => () => void;
}

export type Log = (
  message: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

export interface HostedSession {
  readonly stop: () => Promise<void>;
}

const retryMs = 1000;

export async function hostSession(
  options: SessionOptions,
  stream: SessionStream,
  log: Log,
): Promise<HostedSession> {
  const session = await startSession(options);
  const live = liveQueue(stream, log);
  const transcript = transcriptSync(session, stream, log);

  const unsubscribe = session.subscribe((event) => {
    const liveEvent = toLiveEvent(event);
    if (liveEvent) {
      live.push(liveEvent);
    }
    if (
      event.type !== "message_update" &&
      event.type !== "tool_execution_update"
    ) {
      transcript.sync();
    }
  });
  const detach = stream.commands((command) => {
    run(session, command).catch((error: unknown) => {
      log("command failed", { command: command.type, error: String(error) });
    });
  });
  live.push({ type: "status", status: "idle" });

  return {
    stop: async () => {
      detach();
      await session.abort();
      unsubscribe();
      transcript.sync();
      await Promise.all([transcript.close(), live.close()]);
      session.dispose();
    },
  };
}

async function run(session: AgentSession, command: Command): Promise<void> {
  switch (command.type) {
    case "message":
      await session.prompt(command.text, { streamingBehavior: "steer" });
      return;
    case "abort":
      await session.abort();
      return;
  }
}

function toLiveEvent(event: AgentSessionEvent): LiveEvent | undefined {
  if (event.type === "agent_start") {
    return { type: "status", status: "running" };
  }
  if (event.type === "agent_settled") {
    return { type: "status", status: "idle" };
  }
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    return { type: "text", delta: event.assistantMessageEvent.delta };
  }
  if (event.type === "tool_execution_start") {
    return {
      type: "tool_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      type: "tool_end",
      toolCallId: event.toolCallId,
      isError: event.isError,
    };
  }
  return undefined;
}

function liveQueue(
  stream: SessionStream,
  log: Log,
): { push: (event: LiveEvent) => void; close: () => Promise<void> } {
  let pending: LiveEvent[] = [];
  let sending = Promise.resolve();
  let scheduled = false;
  let closed = false;
  const schedule = (): void => {
    if (!scheduled) {
      scheduled = true;
      sending = sending.then(send);
    }
  };
  const send = async (): Promise<void> => {
    scheduled = false;
    const events = pending;
    pending = [];
    try {
      await stream.publish(events);
    } catch (error) {
      const status = events.findLast((event) => event.type === "status");
      log("live events dropped", {
        count: events.length,
        error: String(error),
        retryStatusInMs: status && retryMs,
      });
      if (status && !closed) {
        if (!pending.some((event) => event.type === "status")) {
          pending.unshift(status);
        }
        await sleep(retryMs);
        schedule();
      }
    }
  };
  return {
    push: (event) => {
      pending.push(event);
      schedule();
    },
    close: async () => {
      closed = true;
      await sending;
    },
  };
}

function transcriptSync(
  session: AgentSession,
  stream: SessionStream,
  log: Log,
): { sync: () => void; close: () => Promise<void> } {
  let acked = 0;
  let closed = false;
  let running: Promise<void> | undefined;
  let dirty = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const upload = async (): Promise<void> => {
    const file = session.sessionFile;
    if (file === undefined) {
      return;
    }
    const text = await readFile(file, "utf8").catch(() => "");
    const lines = text.split("\n").slice(0, -1);
    if (lines.length > acked) {
      acked = await stream.uploadTranscript(acked, lines.slice(acked));
    }
  };
  const loop = async (): Promise<void> => {
    while (dirty) {
      dirty = false;
      try {
        await upload();
      } catch (error) {
        log("transcript upload failed", {
          acked,
          error: String(error),
          retryInMs: retryMs,
        });
        if (closed) {
          return;
        }
        retry ??= setTimeout(() => {
          retry = undefined;
          sync();
        }, retryMs);
        return;
      }
    }
  };
  const sync = (): void => {
    dirty = true;
    running ??= loop().finally(() => {
      running = undefined;
    });
  };
  return {
    sync,
    close: async () => {
      closed = true;
      clearTimeout(retry);
      await running;
    },
  };
}
