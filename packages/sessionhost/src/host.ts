import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  contentText,
  type ImageContent,
  type UserMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { SessionPlugin } from "@pi-cloud/plugins";
import {
  type Command,
  type ImageAttachment,
  type LiveEvent,
  liveSurface,
  type SlashCommand,
  type ToolSpec,
} from "@pi-cloud/protocol";
import { builtinCommands, builtinOf, runBuiltin, settings } from "./builtins";
import { workspaceFiles } from "./files";
import { remoteUI } from "./ui";
import {
  availableModel,
  type SessionOptions,
  startSession,
  stopSession,
} from "./session";
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
  pluginRequest: (
    plugin: string,
    path: string,
    init?: RequestInit,
  ) => Promise<Response>;
}

export interface HostOptions extends SessionOptions {
  readonly plugins?: readonly SessionPlugin[];
  readonly firstMessage?: string | null;
  readonly serverToolTimeoutMs?: number;
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

// Keeps each upload well inside the request timeout and Bun's body limit.
const transcriptBatchChars = 1_000_000;

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
  startTerminal: (command: TerminalCommand) => void,
): Promise<HostedSession> {
  const live = liveQueue(stream, log);

  const prompts = remoteUI((event) => {
    live.push(event);
  });

  const calls = serverTools(
    await stream.tools(),
    stream.callTool,
    options.serverToolTimeoutMs,
  );

  const plugins = (options.plugins ?? []).map((plugin) => ({
    plugin,
    cloud: {
      publish: (key: string, data: unknown) => {
        live.push({ type: "plugin", plugin: plugin.name, key, data });
      },
      askQuestions: prompts.questions,
      checkouts: options.checkouts ?? [],
      request: async (path: string, init?: RequestInit) =>
        stream.pluginRequest(plugin.name, path, init),
      log: (message: string, fields?: Readonly<Record<string, unknown>>) => {
        log(message, { plugin: plugin.name, ...fields });
      },
    },
  }));

  const pluginTools = await Promise.all(
    plugins.map(async ({ plugin, cloud }) => plugin.tools?.(cloud) ?? []),
  );

  const session = await startSession(options, {
    ui: prompts.ui,
    tools: [...pluginTools.flat(), ...calls.tools],
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
  const files = filesFeed(session.sessionManager.getCwd(), live, log);

  const unsubscribe = session.subscribe((event) => {
    const liveEvent = toLiveEvent(event);
    if (liveEvent) {
      live.push(liveEvent);
    }

    if (event.type === "agent_settled") {
      files.refresh();
    }

    if (
      event.type !== "message_update" &&
      event.type !== "tool_execution_update"
    ) {
      transcript.sync();
    }
  });

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

    if (command.type === "unqueue") {
      const back = unqueue(session, command);
      if (back !== undefined) {
        live.push({ type: "editor_text", text: back });
      }

      return;
    }

    const builtin =
      command.type === "message" ? builtinOf(session, command.text) : undefined;

    if (builtin) {
      runBuiltin(session, builtin, {
        prompts,
        push: (event) => {
          live.push(event);
        },
      }).then(
        () => {
          if (builtin.name === "reload") {
            live.push({ type: "commands", commands: slashCommands(session) });
          }
        },
        (error: unknown) => {
          log("command failed", {
            command: builtin.name,
            error: String(error),
          });

          live.push({
            type: "notify",
            level: "error",
            message: `/${builtin.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        },
      );

      return;
    }

    run(session, command).then(
      async () => {
        if (command.type === "set_model" || command.type === "set_thinking") {
          live.push(await settings(session));
        }
      },
      (error: unknown) => {
        log("command failed", { command: command.type, error: String(error) });

        live.push({
          type: "notify",
          level: "error",
          message: `${command.type} failed: ${String(error)}`,
        });
      },
    );
  });

  live.push({ type: "status", status: "idle" });
  live.push({ type: "commands", commands: slashCommands(session) });
  live.push(await settings(session));
  files.refresh();
  transcript.sync();

  const firstMessage = options.firstMessage ?? null;
  if (
    firstMessage !== null &&
    !session.sessionManager.getEntries().some(({ type }) => type === "message")
  ) {
    session.prompt(firstMessage).catch((error: unknown) => {
      log("first message failed", { error: String(error) });

      live.push({
        type: "notify",
        level: "error",
        message: `first message failed: ${String(error)}`,
      });
    });
  }

  return {
    stop: async () => {
      detach();
      files.stop();

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
  command: Extract<
    Command,
    { type: "message" | "abort" | "context" | "set_model" | "set_thinking" }
  >,
): Promise<void> {
  switch (command.type) {
    case "set_model":
      await session.setModel(
        await availableModel(session.modelRuntime, command.model),
      );

      return;
    case "set_thinking":
      session.setThinkingLevel(command.level);

      return;
    case "context":
      await session.sendCustomMessage(
        {
          customType: "pi-cloud-context",
          content: command.text,
          display: true,
        },
        { triggerTurn: false },
      );

      return;
    case "message":
      await session.prompt(command.text, {
        streamingBehavior: command.delivery ?? "steer",
        ...(command.images && { images: images(command.images) }),
      });

      return;
    case "abort":
      await session.abort();

      return;
  }
}

// Removes text from Pi's queue and queues the rest again in order. Returns
// the text, or undefined when Pi has already read it.
function unqueue(
  session: AgentSession,
  { delivery, text }: Extract<Command, { type: "unqueue" }>,
): string | undefined {
  const queued = queuedMessages(session.agent);

  const index = queued[delivery].findIndex(
    (message) =>
      message.role === "user" && contentText(message.content, "") === text,
  );

  if (index === -1) {
    return undefined;
  }

  queued[delivery].splice(index, 1);
  session.clearQueue();

  void requeue(session, "steer", queued.steer);
  void requeue(session, "followUp", queued.followUp);

  return text;
}

type Delivery = Extract<Command, { type: "unqueue" }>["delivery"];

type AgentMessage = AgentSession["messages"][number];

// Pi's agent shows its queues only through peekQueuedMessages, which returns
// the steering queue, or the follow-up queue when no steering is queued.
function queuedMessages(
  agent: AgentSession["agent"],
): Record<Delivery, AgentMessage[]> {
  const { steeringMode, followUpMode } = agent;
  agent.steeringMode = "all";
  agent.followUpMode = "all";

  const steeringOrFollowUp = agent.peekQueuedMessages();
  agent.clearSteeringQueue();
  const followUp = agent.peekQueuedMessages();

  const steering =
    steeringOrFollowUp[0] === followUp[0] ? [] : steeringOrFollowUp;

  for (const message of steering) {
    agent.steer(message);
  }

  agent.steeringMode = steeringMode;
  agent.followUpMode = followUpMode;

  return { steer: steering, followUp };
}

// Queues messages one at a time so they keep their order. User messages go
// through Pi's session, which lists them in its queue, and messages from
// extensions go straight to the agent, as Pi queued them.
async function requeue(
  session: AgentSession,
  delivery: Delivery,
  messages: readonly AgentMessage[],
): Promise<void> {
  for (const message of messages) {
    if (message.role === "user") {
      await session[delivery](
        contentText(message.content, ""),
        imagesOf(message.content),
      );
    } else {
      session.agent[delivery](message);
    }
  }
}

function imagesOf(content: UserMessage["content"]): ImageContent[] | undefined {
  const found =
    typeof content === "string"
      ? []
      : content.filter((part) => part.type === "image");

  return found.length > 0 ? found : undefined;
}

function images(attached: readonly ImageAttachment[]): ImageContent[] {
  return attached.map((image) => ({ type: "image", ...image }));
}

// Publishes the workspace's paths when they differ from the last ones sent.
function filesFeed(
  cwd: string,
  live: { push: (event: LiveEvent) => void },
  log: Log,
): { readonly refresh: () => void; readonly stop: () => void } {
  let sent = "";
  let stopped = false;

  return {
    refresh: () => {
      workspaceFiles(cwd).then(
        ({ paths, truncated }) => {
          const key = `${String(truncated)}\0${paths.join("\0")}`;
          if (stopped || key === sent) {
            return;
          }

          sent = key;
          live.push({ type: "files", paths, truncated });
        },
        (error: unknown) => {
          log("listing workspace files failed", { error: String(error) });
        },
      );
    },
    stop: () => {
      stopped = true;
    },
  };
}

// The same list Pi's RPC mode answers get_commands with.
function slashCommands(session: AgentSession): readonly SlashCommand[] {
  const extensions = session.extensionRunner
    .getRegisteredCommands()
    .map(({ invocationName, description }): SlashCommand => ({
      name: invocationName,
      description: description ?? null,
      source: "extension",
    }));

  return [
    ...builtinCommands.filter(
      ({ name }) => !extensions.some((command) => command.name === name),
    ),
    ...extensions,
    ...session.promptTemplates.map(({ name, description }): SlashCommand => ({
      name,
      description,
      source: "prompt",
    })),
    ...session.resourceLoader
      .getSkills()
      .skills.map(({ name, description }): SlashCommand => ({
        name: `skill:${name}`,
        description,
        source: "skill",
      })),
  ];
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

      const retry = [...(status ? [status] : []), ...latestSurfaces(events)];

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

      let drained: Promise<void>;
      do {
        drained = sending;
        await drained;
      } while (drained !== sending);
    },
  };
}

// The server keeps only the latest event for each surface, so a failed post
// needs to resend no more than that.
function latestSurfaces(events: readonly LiveEvent[]): LiveEvent[] {
  const latest = new Map<string, LiveEvent>();

  for (const event of events) {
    const surface = liveSurface(event);
    if (surface) {
      latest.delete(surface.key);
      latest.set(surface.key, event);
    }
  }

  return [...latest.values()];
}

function transcriptSync(
  session: AgentSession,
  stream: SessionStream,
  log: Log,
): { sync: () => void; close: () => Promise<void> } {
  let acked: number | undefined;
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

    acked ??= await stream.uploadTranscript(0, []);
    while (acked < lines.length) {
      const start = acked;

      acked = await stream.uploadTranscript(
        start,
        transcriptBatch(lines, start),
      );

      if (acked <= start) {
        break;
      }
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

function transcriptBatch(
  lines: readonly string[],
  start: number,
): readonly string[] {
  let end = start + 1;
  let size = lines[start]?.length ?? 0;
  while (end < lines.length) {
    size += lines[end]?.length ?? 0;
    if (size > transcriptBatchChars) {
      break;
    }

    end++;
  }

  return lines.slice(start, end);
}
