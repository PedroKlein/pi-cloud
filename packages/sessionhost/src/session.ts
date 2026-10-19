import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  type ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { PromptUI } from "./prompts";

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

export async function startSession(
  options: SessionOptions,
  ui?: PromptUI,
): Promise<AgentSession> {
  const { agentDir } = options;
  const cwd = await workingDirectory(options.cwd);

  // Pi's CLI sets the theme before any mode runs, and extensions style their
  // status text with it even when no terminal renders it.
  initTheme();

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [...options.extensionPaths],
  });

  await resourceLoader.reload();

  const { errors } = resourceLoader.getExtensions();
  if (errors.length > 0) {
    const details = errors.map((e) => `${e.path}: ${e.error}`).join("; ");
    throw new Error(`extensions failed to load: ${details}`);
  }

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    sessionManager: SessionManager.continueRecent(cwd, options.sessionDir),
    ...(options.models && {
      modelRuntime: options.models.runtime,
      model: options.models.model,
    }),
  });

  await session.bindExtensions(
    ui
      ? {
          uiContext: { ...session.extensionRunner.getUIContext(), ...ui },
          mode: "rpc",
        }
      : {},
  );

  return session;
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
