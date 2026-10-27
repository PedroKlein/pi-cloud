import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionServices,
  type ToolDefinition,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type ExtensionError,
  hasTrustRequiringProjectResources,
  initTheme,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  type ResourceDiagnostic,
  type Skill,
  SettingsManager,
  type ToolExposure,
} from "@earendil-works/pi-coding-agent";
import type { Checkout } from "@pipoca/plugins";
import type { ModelRef, ThinkingLevel } from "@pipoca/protocol";
import chalk from "chalk";
import { pluginPackages } from "./packages";
import type { Surfaces } from "./surfaces";
import type { RemoteUI } from "./ui";
import "./codemode";

export interface ModelOptions {
  // The Pi agent folder: a Session's is its Profile's (ADR 0031).
  readonly agentDir: string;
  // The machine's own logins and custom models, shared by all its Profiles.
  readonly authPath: string;
  readonly modelsPath: string;
  readonly extensionPaths: readonly string[];
  readonly models?: {
    readonly runtime: ModelRuntime;
    readonly model: Model<Api>;
  };
}

export interface SessionOptions extends ModelOptions {
  readonly cwd: string;
  readonly checkouts?: readonly Checkout[];
  readonly sessionDir: string;
  readonly model?: ModelRef;
  readonly thinking?: ThinkingLevel;
  readonly systemPrompt?: string | null;
  // The user's answer for the repository's own .pi, or null before anyone
  // was asked (ADR 0031).
  readonly trusted?: boolean | null;
}

export interface SessionHost {
  readonly ui: RemoteUI & Surfaces;
  readonly tools: readonly ToolDefinition[];
  readonly extensions: readonly InlineExtension[];
  // Pi package sources plugins load in every Session.
  readonly packages: readonly string[];
  readonly onError: (error: ExtensionError) => void;
}

// The tool that lets the model reach tools of each exposure it isn't
// declared with.
const finderOf: Partial<Record<ToolExposure, string>> = {
  deferred: "tool_search",
  codemode: "codemode",
};

// Pi turns these on by itself only for MCP servers whose tools need them. A
// resumed transcript or /tree restores the tools active back then, so they're
// turned on again after each.
function toolFinders(tools: readonly ToolDefinition[]): InlineExtension {
  const finders = new Set(
    tools.flatMap(({ exposure }) =>
      exposure === undefined ? [] : (finderOf[exposure] ?? []),
    ),
  );

  return {
    name: "tool-finders",
    factory: (pi) => {
      if (finders.size === 0) {
        return;
      }

      const activate = (): void => {
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...finders])]);
      };

      pi.on("session_start", activate);
      pi.on("session_tree", activate);
    },
  };
}

// The extensions Pi's CLI builds in, so hosted sessions get the same tools.
// Its llama.cpp provider isn't exported, so it's left out.
const builtInExtensions: InlineExtension[] = [
  { name: "codemode", factory: createCodemodeExtension() },
  { name: "tool-search", factory: createToolSearchExtension() },
  { name: "mcp", factory: createMcpExtension() },
].map((extension) => ({ ...extension, replaceable: true, builtin: true }));

export async function startSession(
  options: SessionOptions,
  host?: SessionHost,
): Promise<AgentSession> {
  const cwd = await workingDirectory(options.cwd);

  // Pi's CLI sets the theme before any mode runs, and extensions style their
  // status text with it even when no terminal renders it.
  initTheme();

  // Pi styles bold and italic text with chalk, which leaves styles out without
  // a terminal. What extensions draw goes to the web and the Pi view.
  chalk.level = 3;

  const systemPrompt = options.systemPrompt ?? null;

  const services = await loadServices(cwd, options, {
    projectTrusted: options.trusted ?? !asksForTrust(cwd, options),
    ...(systemPrompt !== null && { appendSystemPrompt: [systemPrompt] }),
    extensionFactories: [
      ...builtInExtensions,
      ...(host ? [toolFinders(host.tools)] : []),
      ...(host?.extensions ?? []),
    ],
    ...(host && { packages: host.packages, onError: host.onError }),
  });

  const sessionManager = SessionManager.continueRecent(cwd, options.sessionDir);
  recordInterruptedToolCalls(sessionManager);

  // Pi restores the model and reasoning level a resumed session last used, so
  // the chosen ones only set the first.
  const fresh = sessionManager.buildSessionContext().messages.length === 0;

  const model = fresh
    ? await firstModel(services.modelRuntime, options)
    : undefined;

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(host && { customTools: [...host.tools] }),
    ...(model && { model }),
    ...(fresh && options.thinking && { thinkingLevel: options.thinking }),
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

// A repository's .pi can run code, so Pi loads it only once the user trusts
// the repository. Without anything there, there's nothing to ask.
export function asksForTrust(
  cwd: string,
  options: Pick<SessionOptions, "trusted">,
): boolean {
  return options.trusted === null && hasTrustRequiringProjectResources(cwd);
}

// Pi rereads its auth file, so each call sees logins made since.
export async function modelLister(
  options: ModelOptions,
): Promise<() => Promise<readonly ModelRef[]>> {
  const { modelRuntime } = await loadServices(homedir(), options);

  return async () =>
    (await modelRuntime.getAvailable()).map(({ provider, id }) => ({
      provider,
      id,
    }));
}

// Services register the providers extensions add before the default model is
// resolved, as Pi's CLI does.
async function loadServices(
  cwd: string,
  options: ModelOptions,
  {
    packages = [],
    onError = () => undefined,
    projectTrusted = true,
    ...resources
  }: {
    readonly projectTrusted?: boolean;
    readonly appendSystemPrompt?: string[];
    readonly extensionFactories?: InlineExtension[];
    readonly packages?: readonly string[];
    readonly onError?: (error: ExtensionError) => void;
  } = {},
): Promise<AgentSessionServices> {
  const { agentDir } = options;

  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted,
  });

  const plugins = await pluginPackages(
    packages,
    { cwd, agentDir, settingsManager },
    onError,
  );

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: {
      ...resources,
      additionalExtensionPaths: [...plugins.sources, ...options.extensionPaths],
      extensionsOverride: plugins.override,
      skillsOverride: withoutHomeSkills,
      agentsFilesOverride: withoutHomeContext,
    },
    modelRuntime:
      options.models?.runtime ??
      (await ModelRuntime.create({
        authPath: options.authPath,
        modelsPath: options.modelsPath,
      })),
  });

  const { errors } = services.resourceLoader.getExtensions();
  if (errors.length > 0) {
    const details = errors.map((e) => `${e.path}: ${e.error}`).join("; ");
    throw new Error(`extensions failed to load: ${details}`);
  }

  return services;
}

// Pi always loads ~/.agents/skills as the user's own. Sessions take the
// user's setup from their Profile instead, so they behave the same on every
// machine (ADR 0031).
function withoutHomeSkills(base: {
  skills: Skill[];
  diagnostics: ResourceDiagnostic[];
}): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  const home = join(process.env["HOME"] ?? homedir(), ".agents", "skills");

  return {
    ...base,
    skills: base.skills.filter(
      ({ filePath }) => !filePath.startsWith(`${home}${sep}`),
    ),
  };
}

// Pi reads AGENTS.md and CLAUDE.md in every folder above the working
// directory, the home folder too when the workspace is under it.
function withoutHomeContext(base: {
  agentsFiles: { path: string; content: string }[];
}): { agentsFiles: { path: string; content: string }[] } {
  const home = process.env["HOME"] ?? homedir();

  return {
    agentsFiles: base.agentsFiles.filter(({ path }) => dirname(path) !== home),
  };
}

async function firstModel(
  runtime: ModelRuntime,
  options: SessionOptions,
): Promise<Model<Api> | undefined> {
  if (options.model === undefined) {
    return options.models?.model;
  }

  return availableModel(runtime, options.model);
}

export async function availableModel(
  runtime: ModelRuntime,
  { provider, id }: ModelRef,
): Promise<Model<Api>> {
  const models = await runtime.getAvailable(provider);
  const model = models.find((m) => m.id === id);
  if (model === undefined) {
    throw new Error(`model not available: ${provider}/${id}`);
  }

  return model;
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
