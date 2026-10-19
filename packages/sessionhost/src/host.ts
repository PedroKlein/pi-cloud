import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { Command, LiveEvent } from "@pi-cloud/protocol";
import { remotePrompts } from "./prompts";
import { type SessionOptions, startSession, stopSession } from "./session";
import { openTerminal } from "./terminal";

export interface SessionStream {
  uploadTranscript: (
    start: number,
    lines: readonly string[],
  ) => Promise<number>;
  publish: (events: readonly LiveEvent[]) => Promise<void>;
  commands: (listener: (command: Command) => void) => () => void;
  terminal: (terminalId: string, peer: TerminalPeer) => TerminalChannel;
}

export interface TerminalPeer {
  input: (data: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  closed: () => void;
}

export interface TerminalChannel {
  send: (data: Uint8Array) => void;
  close: () => void;
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
  const live = liveQueue(stream, log);
  const prompts = remotePrompts((event) => {
    live.push(event);
  });
  const session = await startSession(options, prompts.ui);
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
  const terminals = new Map<string, () => void>();
  const detach = stream.commands((command) => {
    if (command.type === "answer") {
      prompts.answer(command.id, command.value);
      return;
    }
    if (command.type === "terminal") {
      terminals.set(
        command.terminalId,
        attachTerminal(options.cwd, command, stream, log, () => {
          terminals.delete(command.terminalId);
        }),
      );
      return;
    }
    run(session, command).catch((error: unknown) => {
      log("command failed", { command: command.type, error: String(error) });
    });
  });
  live.push({ type: "status", status: "idle" });
  transcript.sync();

  return {
    stop: async () => {
      detach();
      for (const close of terminals.values()) {
        close();
      }
      prompts.cancelAll();
      await stopSession(session);
      unsubscribe();
      transcript.sync();
      await Promise.all([transcript.close(), live.close()]);
    },
  };
}

function attachTerminal(
  cwd: string,
  command: Extract<Command, { type: "terminal" }>,
  stream: SessionStream,
  log: Log,
  exited: () => void,
): () => void {
  const { terminalId, cols, rows } = command;
  const pending: Uint8Array[] = [];
  let output = (data: Uint8Array): void => {
    pending.push(data);
  };
  const terminal = openTerminal({ cwd, cols, rows }, (data) => {
    output(data);
  });
  const channel = stream.terminal(terminalId, {
    input: (data) => {
      terminal.write(data);
    },
    resize: (c, r) => {
      terminal.resize(c, r);
    },
    closed: () => {
      terminal.close();
    },
  });
  pending.forEach(channel.send);
  output = channel.send;
  log("terminal opened", { terminalId });
  void terminal.exited.then((code) => {
    log("terminal exited", { terminalId, code });
    channel.close();
    exited();
  });
  return () => {
    terminal.close();
  };
}

async function run(
  session: AgentSession,
  command: Exclude<Command, { type: "terminal" | "answer" }>,
): Promise<void> {
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
      const status = pending.some((event) => event.type === "status")
        ? undefined
        : events.findLast((event) => event.type === "status");
      const retry = [
        ...(status ? [status] : []),
        ...events.filter(
          (event) => event.type === "prompt" || event.type === "prompt_end",
        ),
      ];
      log("live events dropped", {
        count: events.length - retry.length,
        error: String(error),
        retryInMs: retry.length > 0 ? retryMs : undefined,
      });
      if (retry.length > 0 && !closed) {
        pending.unshift(...retry);
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
    if (acked > lines.length) {
      log("server transcript is longer than the local file", {
        file,
        acked,
        lines: lines.length,
      });
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
