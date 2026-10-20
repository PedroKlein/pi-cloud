import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type ToolDefinition,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionError,
  initTheme,
  type ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { RemoteUI } from "./ui";

export interface SessionOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly extensionPaths: readonly string[];
  readonly models?: {
    readonly runtime: ModelRuntime;
    readonly model: Model<Api>;
  };
}

export interface SessionHost {
  readonly ui: RemoteUI;
  readonly tools: readonly ToolDefinition[];
  readonly onError: (error: ExtensionError) => void;
}

export async function startSession(
  options: SessionOptions,
  host?: SessionHost,
): Promise<AgentSession> {
  const { agentDir } = options;
  const cwd = await workingDirectory(options.cwd);

  // Pi's CLI sets the theme before any mode runs, and extensions style their
  // status text with it even when no terminal renders it.
  initTheme();

  // Services register the providers extensions add before the default model
  // is resolved, as Pi's CLI does.
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    resourceLoaderOptions: {
      additionalExtensionPaths: [...options.extensionPaths],
    },
    ...(options.models && { modelRuntime: options.models.runtime }),
  });

  const { errors } = services.resourceLoader.getExtensions();
  if (errors.length > 0) {
    const details = errors.map((e) => `${e.path}: ${e.error}`).join("; ");
    throw new Error(`extensions failed to load: ${details}`);
  }

  const sessionManager = SessionManager.continueRecent(cwd, options.sessionDir);
  recordInterruptedToolCalls(sessionManager);

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(host && { customTools: [...host.tools] }),
    ...(options.models && { model: options.models.model }),
  });

  await session.bindExtensions(
    host
      ? {
          uiContext: { ...session.extensionRunner.getUIContext(), ...host.ui },
          mode: "rpc",
          onError: host.onError,
        }
      : {},
  );

  return session;
}

// Pi fills a missing tool result with "No result provided" when it builds the
// next request, which hides that the tool may have partly run before the crash.
function recordInterruptedToolCalls(sessionManager: SessionManager): void {
  const messages = sessionManager
    .getBranch()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));

  const callIndex = messages.findLastIndex((m) => m.role === "assistant");
  const call = messages[callIndex];
  if (call?.role !== "assistant" || call.stopReason !== "toolUse") {
    return;
  }

  const answered = new Set(
    messages
      .slice(callIndex + 1)
      .flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
  );

  for (const block of call.content) {
    if (block.type === "toolCall" && !answered.has(block.id)) {
      sessionManager.appendMessage({
        role: "toolResult",
        toolCallId: block.id,
        toolName: block.name,
        content: [
          {
            type: "text",
            text: "The tool was interrupted by a restart and may have partly run.",
          },
        ],
        isError: true,
        timestamp: Date.now(),
      });
    }
  }
}

async function workingDirectory(path: string): Promise<string> {
  const expanded =
    path === "~" || path.startsWith("~/")
      ? join(homedir(), path.slice(1))
      : path;

  const found = isAbsolute(expanded)
    ? await stat(expanded).catch(() => undefined)
    : undefined;

  if (found?.isDirectory() !== true) {
    throw new Error(`working directory not found: ${path}`);
  }

  return expanded;
}

export async function stopSession(session: AgentSession): Promise<void> {
  await session.abort();

  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });

  session.dispose();
}
