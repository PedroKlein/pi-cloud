import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionError,
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

export interface SessionHost {
  readonly ui: PromptUI;
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

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.continueRecent(cwd, options.sessionDir),
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
