interface Entry {
  readonly type: string;
  readonly message?: {
    readonly role: string;
    readonly content:
      string | readonly { type: string; text?: string; name?: string }[];
    readonly stopReason?: string;
    readonly errorMessage?: string;
  };
}

// The model error a thread's last turn ended with, if it did.
export function turnError(transcript: readonly string[]): string | undefined {
  for (const line of transcript.toReversed()) {
    const { message } = JSON.parse(line) as Entry;
    if (message?.role === "assistant") {
      return message.stopReason === "error"
        ? (message.errorMessage ?? "unknown error")
        : undefined;
    }
  }

  return undefined;
}

export function messagedCoordinator(transcript: readonly string[]): boolean {
  for (const line of transcript.toReversed()) {
    const { message } = JSON.parse(line) as Entry;
    if (message?.role === "user") {
      return false;
    }

    if (
      message?.role === "assistant" &&
      typeof message.content !== "string" &&
      message.content.some(
        (part) =>
          part.type === "toolCall" && part.name === "message_coordinator",
      )
    ) {
      return true;
    }
  }

  return false;
}

export function messageText(line: string):
  | {
      readonly role: string;
      readonly text: string;
    }
  | undefined {
  const entry = JSON.parse(line) as Entry;
  if (entry.type !== "message" || entry.message === undefined) {
    return undefined;
  }

  const { role, content } = entry.message;

  const text =
    typeof content === "string"
      ? content
      : content
          .flatMap((part) => (part.type === "text" ? (part.text ?? []) : []))
          .join("");

  return text.trim() === "" ? undefined : { role, text: text.trim() };
}

export function lastReply(transcript: readonly string[]): string | undefined {
  for (const line of transcript.toReversed()) {
    const message = messageText(line);
    if (message?.role === "assistant") {
      return message.text;
    }
  }

  return undefined;
}
