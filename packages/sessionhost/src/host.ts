import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { SessionPlugin } from "@pi-cloud/plugins";
import type { Command, LiveEvent, ToolSpec } from "@pi-cloud/protocol";
import { remoteUI } from "./ui";
import { type SessionOptions, startSession, stopSession } from "./session";
import { openTerminal } from "./terminal";
import { serverTools } from "./tools";

export interface SessionStream {
  uploadTranscript: (
    start: number,
    lines: readonly string[],
  ) => Promise<number>;
  publish: (events: readonly LiveEvent[]) => Promise<void>;
  commands: (listener: (command: Command) => void) => () => void;
  terminal: (terminalId: string, peer: TerminalPeer) => TerminalChannel;
  tools: () => Promise<readonly ToolSpec[]>;
  callTool: (id: string, name: string, input: unknown) => Promise<void>;
}

export interface HostOptions extends SessionOptions {
  readonly plugins?: readonly SessionPlugin[];
  readonly firstMessage?: string | null;
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

const resent: readonly LiveEvent["type"][] = [
  "prompt",
  "prompt_end",
  "extension_status",
  "widget",
  "title",
  "queue",
  "plugin",
];

export type TerminalCommand = Extract<Command, { type: "terminal" }>;

interface Terminals {
  readonly open: (command: TerminalCommand) => void;
  readonly close: () => void;
}

// Opens session terminals in cwd, each over its own socket from stream.
export function hostTerminals(
  cwd: string,
  stream: Pick<SessionStream, "terminal">,
  log: Log,
): Terminals {
  const terminals = new Map<string, () => void>();

  return {
    open: (command) => {
      try {
        terminals.set(
          command.terminalId,
          attachTerminal(cwd, command, stream, log, () => {
            terminals.delete(command.terminalId);
          }),
        );
      } catch (error) {
        log("terminal failed to start", {
          terminalId: command.terminalId,
          error: String(error),
        });

        stream.terminal(command.terminalId, ignoredPeer).close();
      }
    },
    close: () => {
      for (const close of terminals.values()) {
        close();
      }
    },
  };
}

export async function hostSession(
  options: HostOptions,
  stream: SessionStream,
  log: Log,
  openTerminalElsewhere?: (command: TerminalCommand) => void,
): Promise<HostedSession> {
  const live = liveQueue(stream, log);

  const prompts = remoteUI((event) => {
    live.push(event);
  });

  const calls = serverTools(await stream.tools(), stream.callTool);

  const plugins = (options.plugins ?? []).map((plugin) => ({
    plugin,
    cloud: {
      publish: (key: string, data: unknown) => {
        live.push({ type: "plugin", plugin: plugin.name, key, data });
      },
      askQuestions: prompts.questions,
      checkouts: options.checkouts ?? [],
      log: (message: string, fields?: Readonly<Record<string, unknown>>) => {
        log(message, { plugin: plugin.name, ...fields });
      },
    },
  }));

  const session = await startSession(options, {
    ui: prompts.ui,
    tools: [
      ...plugins.flatMap(({ plugin, cloud }) => plugin.tools?.(cloud) ?? []),
      ...calls.tools,
    ],
    extensions: plugins.flatMap(({ plugin, cloud }) =>
      plugin.extension ? [plugin.extension(cloud)] : [],
    ),
    onError: (error) => {
      log("extension error", {
        extension: error.extensionPath,
        event: error.event,
        error: error.error,
      });
    },
  });

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

  const terminals = hostTerminals(session.sessionManager.getCwd(), stream, log);
  const startTerminal = openTerminalElsewhere ?? terminals.open;

  const detach = stream.commands((command) => {
    log("command received", { command: command.type, actor: command.actor });

    if (command.type === "answer") {
      prompts.answer(command.id, command.value);

      return;
    }

    if (command.type === "explain") {
      prompts.explain(command);

      return;
    }

    if (command.type === "terminal") {
      startTerminal(command);

      return;
    }

    if (command.type === "tool_result") {
      calls.result(command.id, command.result);

      return;
    }

    run(session, command).catch((error: unknown) => {
      log("command failed", { command: command.type, error: String(error) });

      live.push({
        type: "notify",
        level: "error",
        message: `${command.type} failed: ${String(error)}`,
      });
    });
  });

  live.push({ type: "status", status: "idle" });
  transcript.sync();

  const firstMessage = options.firstMessage ?? null;
  if (
    firstMessage !== null &&
    !session.sessionManager.getEntries().some(({ type }) => type === "message")
  ) {
    session.prompt(firstMessage).catch((error: unknown) => {
      log("first message failed", { error: String(error) });
    });
  }

  return {
    stop: async () => {
      detach();
      terminals.close();

      prompts.cancelAll();
      calls.cancelAll();
      await stopSession(session);
      unsubscribe();
      transcript.sync();
      await Promise.all([transcript.close(), live.close()]);
    },
  };
}

const ignoredPeer: TerminalPeer = {
  input: () => undefined,
  resize: () => undefined,
  closed: () => undefined,
};

function attachTerminal(
  cwd: string,
  command: TerminalCommand,
  stream: Pick<SessionStream, "terminal">,
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
  command: Extract<Command, { type: "message" | "abort" }>,
): Promise<void> {
  switch (command.type) {
    case "message":
      await session.prompt(command.text, {
        streamingBehavior: command.delivery ?? "steer",
      });

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

  if (event.type === "queue_update") {
    return {
      type: "queue",
      steering: event.steering,
      followUp: event.followUp,
    };
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
        ...events.filter((event) => resent.includes(event.type)),
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
