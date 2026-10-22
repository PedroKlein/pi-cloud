import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  type LiveEvent,
  type SlashCommand,
  thinkingLevels,
} from "@pi-cloud/protocol";
import { availableModel } from "./session";

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

// Runs a built-in command and returns what to tell the browser.
export async function runBuiltin(
  session: AgentSession,
  { name, args }: Builtin,
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
    default:
      return undefined;
  }
}

export function settings(session: AgentSession): LiveEvent {
  const { model } = session;

  return {
    type: "settings",
    model: model ? { provider: model.provider, id: model.id } : null,
    thinking: session.thinkingLevel,
    levels: session.getAvailableThinkingLevels(),
  };
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
