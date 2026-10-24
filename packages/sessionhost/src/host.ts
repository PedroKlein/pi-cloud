import { existsSync } from "node:fs";
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
  ExtensionError,
} from "@earendil-works/pi-coding-agent";
import type { SessionPlugin } from "@pi-cloud/plugins";
import {
  type Command,
  type ImageAttachment,
  type LiveEvent,
  liveSurface,
  noticeType,
  piTerminal,
  type SlashCommand,
  type ToolSpec,
} from "@pi-cloud/protocol";
import { builtinCommands, builtinOf, runBuiltin, settings } from "./builtins";
import { workspaceFiles } from "./files";
import { webSurfaces } from "./surfaces";
import { remoteUI } from "./ui";
import {
  asksForTrust,
  availableModel,
  type SessionOptions,
  startSession,
  stopSession,
} from "./session";
import { openTerminal, type Terminal } from "./terminal";
import { serverTools } from "./tools";
import { piView } from "./tui";

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
  // Keeps the user's answer for the repository the Session works in.
  answerTrust: (trusted: boolean) => Promise<void>;
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
  // The user closed the terminal's tab.
  end: () => void;
  // The socket went away; the shell keeps running.
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

// What a shell printed while nobody watched, replayed to the next socket.
const keptOutputBytes = 64 * 1024;

interface Kept {
  readonly label: string;
  readonly shell: Terminal;
  readonly output: Uint8Array[];
  channel: TerminalChannel | undefined;
}

// Opens session terminals in cwd. A shell outlives its socket until it exits,
// its tab is closed or the Session stops, and a later socket for the same
// terminal picks it up again (ADR 0026).
export function hostTerminals(
  cwd: string,
  stream: Pick<SessionStream, "terminal" | "publish">,
  log: Log,
): Terminals {
  const kept = new Map<string, Kept>();
  let opened = 0;

  const publish = (): void => {
    const terminals = [...kept].map(([id, { label }]) => ({ id, label }));

    stream
      .publish([{ type: "terminals", terminals }])
      .catch((error: unknown) => {
        log("terminal list failed to publish", { error: String(error) });
      });
  };

  const attach = (terminalId: string, terminal: Kept): void => {
    terminal.channel?.close();

    const channel = stream.terminal(terminalId, {
      input: (data) => {
        terminal.shell.write(data);
      },
      resize: (cols, rows) => {
        terminal.shell.resize(cols, rows);
      },
      end: () => {
        terminal.shell.close();
      },
      closed: () => {
        if (terminal.channel === channel) {
          terminal.channel = undefined;
        }
      },
    });

    terminal.channel = channel;
    terminal.output.forEach(channel.send);
  };

  const start = (command: TerminalCommand): Kept => {
    const { terminalId, cols, rows } = command;
    const output: Uint8Array[] = [];
    let size = 0;

    const shell = openTerminal({ cwd, cols, rows }, (data) => {
      output.push(data);
      size += data.byteLength;

      while (size > keptOutputBytes && output.length > 1) {
        size -= output.shift()?.byteLength ?? 0;
      }

      kept.get(terminalId)?.channel?.send(data);
    });

    opened += 1;

    const terminal: Kept = {
      label: `Terminal ${String(opened)}`,
      shell,
      output,
      channel: undefined,
    };

    void shell.exited.then((code) => {
      log("terminal exited", { terminalId, code });
      terminal.channel?.close();
      kept.delete(terminalId);
      publish();
    });

    return terminal;
  };

  return {
    open: (command) => {
      const { terminalId } = command;

      try {
        const existing = kept.get(terminalId);
        const terminal = existing ?? start(command);

        if (existing) {
          existing.shell.resize(command.cols, command.rows);
        } else {
          kept.set(terminalId, terminal);
          publish();
        }

        attach(terminalId, terminal);

        log(existing ? "terminal reattached" : "terminal opened", {
          terminalId,
        });
      } catch (error) {
        log("terminal failed to start", { terminalId, error: String(error) });
        stream.terminal(terminalId, ignoredPeer).close();
      }
    },
    close: () => {
      for (const { shell } of kept.values()) {
        shell.close();
      }
    },
  };
}

const trustIt = "Trust it";
const distrustIt = "Don't trust it";

// The Session starts without the repository's .pi and loads it once the user
// trusts the repository (ADR 0031). Only an explicit answer is kept, so a
// dismissed question, or one a stop cancels, is asked again next time.
async function askForTrust(
  session: AgentSession,
  stream: Pick<SessionStream, "answerTrust">,
  log: Log,
): Promise<void> {
  const answer = await session.extensionRunner
    .getUIContext()
    .select(
      `Trust ${session.sessionManager.getCwd()}? It has its own Pi configuration in .pi, such as extensions, which can run code. Pi Cloud asks once for each repository.`,
      [trustIt, distrustIt],
    );

  log("repository trust answered", { answer: answer ?? null });

  if (answer === undefined) {
    return;
  }

  if (answer === trustIt) {
    await loadProjectConfig(session);
  }

  await stream.answerTrust(answer === trustIt).catch((error: unknown) => {
    log("repository trust not kept", { error: String(error) });
  });
}

// Pi's own /reload waits for the agent too: reloading mid-turn would drop the
// tools the turn is using.
async function loadProjectConfig(session: AgentSession): Promise<void> {
  if (session.isStreaming || session.isCompacting) {
    await new Promise<void>((resolve) => {
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_settled") {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  session.settingsManager.setProjectTrusted(true);

  const failure = await session.reload().then(
    () =>
      session.resourceLoader
        .getExtensions()
        .errors.map((e) => `${e.path}: ${e.error}`)
        .join("; "),
    (error: unknown) => String(error),
  );

  if (failure !== "") {
    session.settingsManager.setProjectTrusted(false);
    await session.reload();

    throw new Error(
      `the repository's Pi configuration failed to load: ${failure}`,
    );
  }
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

  // Extensions draw during startSession, before it returns the session.
  const started: { session?: AgentSession } = {};

  const surfaces = webSurfaces(
    (event) => {
      live.push(event);
    },
    {
      cwd: () => started.session?.sessionManager.getCwd(),
      providers: () =>
        new Set(
          started.session?.modelRuntime
            .getAvailableSnapshot()
            .map(({ provider }) => provider),
        ).size,
      log,
    },
  );

  const ui = { ...prompts.ui, ...surfaces.ui };

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

  const view = piView(
    options.agentDir,
    stream,
    (event) => {
      live.push(event);
    },
    log,
  );

  const onError = (error: ExtensionError): void => {
    log("extension error", {
      extension: error.extensionPath,
      event: error.event,
      error: error.error,
    });
  };

  const session = await startSession(options, {
    ui,
    tools: [...pluginTools.flat(), ...calls.tools],
    extensions: [
      { name: "pi-view", factory: view.extension },
      ...plugins.flatMap(({ plugin, cloud }) =>
        plugin.extension
          ? [{ name: plugin.name, factory: plugin.extension(cloud) }]
          : [],
      ),
    ],
    packages: plugins.flatMap(({ plugin }) => plugin.packages ?? []),
    onError,
  });

  const tui = view.host(session, {
    uiContext: { ...session.extensionRunner.getUIContext(), ...ui },
    mode: "rpc",
    onError,
  });

  started.session = session;

  const transcript = transcriptSync(session, stream, log);
  const files = filesFeed(session.sessionManager.getCwd(), live, log);

  // Pi appends a `!` command's result to the transcript without an event.
  const recordBashResult = session.recordBashResult.bind(session);

  session.recordBashResult = (...args) => {
    recordBashResult(...args);
    transcript.sync();
  };

  const unsubscribe = session.subscribe((event) => {
    const liveEvent = toLiveEvent(event, session);
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

    if (command.type === "ui_columns") {
      surfaces.resize(command.columns);

      return;
    }

    if (command.type === "terminal" && command.terminalId === piTerminal) {
      tui.open(command);

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
      const taken = unqueue(session, command);

      if (taken !== undefined && command.sendNow !== true) {
        live.push({ type: "editor_text", text: command.text });
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

  let stopped = false;

  // The first message waits for the trust answer, so its turn already has
  // the repository's configuration.
  const trusting = asksForTrust(session.sessionManager.getCwd(), options)
    ? askForTrust(session, stream, log).then(
        () => {
          live.push({ type: "commands", commands: slashCommands(session) });
        },
        (error: unknown) => {
          log("repository trust failed", { error: String(error) });

          live.push({ type: "notify", level: "error", message: String(error) });
        },
      )
    : Promise.resolve();

  const firstMessage = options.firstMessage ?? null;
  if (
    firstMessage !== null &&
    !session.sessionManager.getEntries().some(({ type }) => type === "message")
  ) {
    void trusting.then(async () => {
      if (stopped) {
        return;
      }

      await session.prompt(firstMessage).catch((error: unknown) => {
        log("first message failed", { error: String(error) });

        live.push({
          type: "notify",
          level: "error",
          message: `first message failed: ${String(error)}`,
        });
      });
    });
  }

  return {
    stop: async () => {
      stopped = true;
      detach();
      tui.close();
      surfaces.close();
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
  end: () => undefined,
  closed: () => undefined,
};

async function run(
  session: AgentSession,
  command: Extract<
    Command,
    {
      type:
        | "message"
        | "abort"
        | "context"
        | "notice"
        | "set_model"
        | "set_thinking";
    }
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
    case "notice":
      await session.sendCustomMessage(
        {
          customType: noticeType,
          content: command.text,
          display: true,
          details: command.notice,
        },
        command.turn
          ? { triggerTurn: true, deliverAs: "followUp" }
          : { triggerTurn: false },
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

// Removes text from Pi's queue, or moves it to the end of the steering queue
// with sendNow, and queues the rest again in order. Returns the message, or
// undefined when Pi has already read it.
function unqueue(
  session: AgentSession,
  { delivery, text, sendNow }: Extract<Command, { type: "unqueue" }>,
): AgentMessage | undefined {
  const queued = queuedMessages(session.agent);

  const index = queued[delivery].findIndex(
    (message) =>
      message.role === "user" && contentText(message.content, "") === text,
  );

  if (index === -1) {
    return undefined;
  }

  const [taken] = queued[delivery].splice(index, 1);
  if (taken !== undefined && sendNow === true) {
    queued.steer.push(taken);
  }

  session.clearQueue();

  void requeue(session, "steer", queued.steer);
  void requeue(session, "followUp", queued.followUp);

  return taken;
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

function toLiveEvent(
  event: AgentSessionEvent,
  session: AgentSession,
): LiveEvent | undefined {
  if (event.type === "agent_start") {
    return { type: "status", status: "running" };
  }

  if (event.type === "agent_settled") {
    return {
      type: "status",
      status: "idle",
      transcriptLength: transcriptLength(session),
    };
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

// Pi's file holds its header and then one line per entry, and only exists
// once the session has a conversation.
function transcriptLength({
  sessionFile,
  sessionManager,
}: AgentSession): number {
  return sessionFile !== undefined && existsSync(sessionFile)
    ? sessionManager.getEntryCount() + 1
    : 0;
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
