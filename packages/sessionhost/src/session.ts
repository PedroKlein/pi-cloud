import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

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
): Promise<AgentSession> {
  const { cwd, agentDir } = options;
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
  return session;
}
