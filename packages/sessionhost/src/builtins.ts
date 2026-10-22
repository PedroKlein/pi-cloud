import type {
  AuthEvent,
  AuthInteraction,
  AuthType,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  type LiveEvent,
  type SlashCommand,
  thinkingLevels,
} from "@pi-cloud/protocol";
import { availableModel } from "./session";
import type { remoteUI } from "./ui";

// Pi's TUI commands that make sense in the web (ADR 0023). The browser runs
// /copy itself.
export const builtinCommands: readonly SlashCommand[] = [
  ["model", "Switch the model: /model provider/id"],
  ["thinking", "Set the reasoning level: /thinking <level>"],
  ["compact", "Compact the context now, with optional instructions"],
  ["name", "Name this session"],
  ["session", "Show this session's messages, tokens and cost"],
  ["reload", "Reload extensions, skills, prompts and context files"],
  ["copy", "Copy the last answer"],
  ["login", "Log in to a provider: /login [provider]"],
  ["logout", "Log out of a provider: /logout [provider]"],
].map(([name = "", description = ""]) => ({
  name,
  description,
  source: "builtin",
}));

export interface Builtin {
  readonly name: string;
  readonly args: string;
}

// The built-in command a message runs, unless an extension took its name.
export function builtinOf(
  session: AgentSession,
  text: string,
): Builtin | undefined {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1];

  if (
    name === undefined ||
    !builtinCommands.some((command) => command.name === name) ||
    session.extensionRunner
      .getRegisteredCommands()
      .some(({ invocationName }) => invocationName === name)
  ) {
    return undefined;
  }

  return { name, args: match?.[2]?.trim() ?? "" };
}

export interface BuiltinContext {
  readonly prompts: Pick<ReturnType<typeof remoteUI>, "ui" | "secret">;
  readonly push: (event: LiveEvent) => void;
}

export async function runBuiltin(
  session: AgentSession,
  builtin: Builtin,
  context: BuiltinContext,
): Promise<void> {
  const reply = await replyTo(session, builtin, context);

  if (reply) {
    context.push(reply);
  }
}

async function replyTo(
  session: AgentSession,
  { name, args }: Builtin,
  context: BuiltinContext,
): Promise<LiveEvent | undefined> {
  switch (name) {
    case "model": {
      const slash = args.indexOf("/");
      if (slash <= 0) {
        throw new Error("usage: /model provider/id");
      }

      await session.setModel(
        await availableModel(session.modelRuntime, {
          provider: args.slice(0, slash),
          id: args.slice(slash + 1),
        }),
      );

      return settings(session);
    }

    case "thinking": {
      const level = thinkingLevels.find((known) => known === args);
      if (level === undefined) {
        throw new Error(
          `"${args}" isn't a reasoning level; use one of ${session.getAvailableThinkingLevels().join(", ")}`,
        );
      }

      session.setThinkingLevel(level);

      return settings(session);
    }

    case "compact":
      await session.compact(args === "" ? undefined : args);

      return {
        type: "notify",
        level: "info",
        message: "Compacted the context.",
      };
    case "name":
      if (args === "") {
        throw new Error("usage: /name <name>");
      }

      session.setSessionName(args);

      return { type: "title", title: args };
    case "session":
      return { type: "notify", level: "info", message: stats(session) };
    case "reload":
      await session.reload();

      return { type: "notify", level: "info", message: "Reloaded." };
    case "login":
      context.push(info(await login(session, args, context)));

      return settings(session);
    case "logout":
      context.push(info(await logout(session, args, context)));

      return settings(session);
    default:
      return undefined;
  }
}

export async function settings(session: AgentSession): Promise<LiveEvent> {
  const { model } = session;
  const available = await session.modelRuntime.getAvailable();

  return {
    type: "settings",
    model: model ? { provider: model.provider, id: model.id } : null,
    thinking: session.thinkingLevel,
    levels: session.getAvailableThinkingLevels(),
    models: available.map(({ provider, id }) => ({ provider, id })),
  };
}

function info(message: string): LiveEvent {
  return { type: "notify", level: "info", message };
}

const methodLabels: Readonly<Record<AuthType, string>> = {
  oauth: "Sign in with an account",
  api_key: "Sign in with an API key",
};

interface Choice<T extends string> {
  readonly id: T;
  readonly label: string;
}

// Pi's TUI /login as prompts: the method, then the provider (ADR 0024).
async function login(
  session: AgentSession,
  args: string,
  context: BuiltinContext,
): Promise<string> {
  const runtime = session.modelRuntime;

  const choices = runtime
    .getProviders()
    .filter((provider) => named(provider.id, provider.name, args))
    .flatMap(({ id, name, auth }) => {
      const label = runtime.getProviderAuthStatus(id).configured
        ? `${name} (logged in)`
        : name;

      return [
        ...(auth.oauth ? [{ id, label, name, type: "oauth" as const }] : []),
        ...(auth.apiKey?.login
          ? [{ id, label, name, type: "api_key" as const }]
          : []),
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  if (choices.length === 0) {
    throw new Error(
      args === "" ? "no provider takes a login" : `no provider "${args}"`,
    );
  }

  const type = await pick(
    context.prompts,
    "How do you want to log in?",
    [...new Set(choices.map((choice) => choice.type))].map((each) => ({
      id: each,
      label: methodLabels[each],
    })),
  );

  const offered = choices.filter((choice) => choice.type === type);
  const id = await pick(context.prompts, "Log in to", offered);
  const name = offered.find((choice) => choice.id === id)?.name ?? id;

  await runtime.login(id, type, interaction(context));

  return type === "oauth"
    ? `Logged in to ${name}.`
    : `Saved the API key for ${name}.`;
}

async function logout(
  session: AgentSession,
  args: string,
  { prompts }: BuiltinContext,
): Promise<string> {
  const runtime = session.modelRuntime;

  const stored = (await runtime.listCredentials())
    .map(({ providerId }) => ({
      id: providerId,
      label: runtime.getProvider(providerId)?.name ?? providerId,
    }))
    .filter(({ id, label }) => named(id, label, args));

  if (stored.length === 0) {
    throw new Error(
      args === ""
        ? "no stored login to remove"
        : `no stored login for "${args}"`,
    );
  }

  const id = await pick(prompts, "Log out of", stored);

  await runtime.logout(id);

  return `Logged out of ${stored.find((each) => each.id === id)?.label ?? id}.`;
}

function named(id: string, name: string, wanted: string): boolean {
  const lower = wanted.toLowerCase();

  return (
    lower === "" || id.toLowerCase() === lower || name.toLowerCase() === lower
  );
}

async function pick<T extends string>(
  { ui }: BuiltinContext["prompts"],
  title: string,
  choices: readonly Choice<T>[],
  signal?: AbortSignal,
): Promise<T> {
  const [only] = choices;
  if (choices.length === 1 && only) {
    return only.id;
  }

  const label = await ui.select(
    title,
    choices.map((choice) => choice.label),
    signal ? { signal } : undefined,
  );

  const picked = choices.find((choice) => choice.label === label);
  if (!picked) {
    throw new Error("Login cancelled");
  }

  return picked.id;
}

function interaction({ prompts, push }: BuiltinContext): AuthInteraction {
  return {
    prompt: async (prompt) => {
      if (prompt.type === "select") {
        return pick(
          prompts,
          prompt.message,
          prompt.options.map(({ id, label }) => ({ id, label })),
          prompt.signal,
        );
      }

      const answer =
        prompt.type === "secret"
          ? await prompts.secret(
              prompt.message,
              prompt.placeholder,
              prompt.signal,
            )
          : await prompts.ui.input(
              prompt.message,
              prompt.placeholder,
              prompt.signal ? { signal: prompt.signal } : undefined,
            );

      if (answer === undefined) {
        throw new Error("Login cancelled");
      }

      return answer;
    },
    notify: (event) => {
      push(info(describe(event)));
    },
  };
}

function describe(event: AuthEvent): string {
  switch (event.type) {
    case "info":
      return [
        event.message,
        ...(event.links ?? []).map(({ url, label }) =>
          label === undefined ? url : `${label}: ${url}`,
        ),
      ].join("\n");
    case "auth_url":
      return [`Open ${event.url} to log in.`, event.instructions ?? ""]
        .join("\n")
        .trim();
    case "device_code":
      return `Enter the code ${event.userCode} at ${event.verificationUri}.`;
    case "progress":
      return event.message;
  }
}

function stats(session: AgentSession): string {
  const { userMessages, assistantMessages, toolCalls, tokens, cost } =
    session.getSessionStats();

  return [
    `${String(userMessages)} user and ${String(assistantMessages)} assistant messages`,
    `${String(toolCalls)} tool calls`,
    `${tokens.total.toLocaleString("en")} tokens`,
    `$${cost.toFixed(4)}`,
  ].join(" · ");
}
