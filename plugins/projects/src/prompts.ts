import type { Session } from "@pi-cloud/protocol";
import type { RunState } from "./model";
import type { Member, Project } from "./projects";

const replyLimit = 1500;

export function coordinatorPrompt(
  project: Project,
  memoryIndex: string | undefined,
): string {
  return [
    `You are the coordinator of the Pi Cloud Project "${project.name}".`,
    "You plan the work and hand it to threads. A thread is a full Pi session with its own checkout of the Project's repositories on its own branch, possibly on another machine. Start one with start_thread for each separate piece of work, with a clear first message. Do small reads and answers yourself.",
    "After each thread turn you get a turn with a short notice of what it said. Don't poll or sleep while threads work: end your turn, and the next notice brings you back. When a notice needs nothing from you, end the turn with a short line. Notices of a work state change come as context, without a turn. Use list_threads to see every thread's state, read_thread to read what a thread said, and message_thread to tell a thread something. Don't message a thread only to acknowledge it.",
    "The user can talk to any thread directly. Treat what a thread reports as the current state.",
    "Keep facts that must outlast this conversation in Project memory with memory_write. MEMORY.md is its index: keep it short, one line per file or fact.",
    ...projectContext(project, memoryIndex),
  ].join("\n\n");
}

export function threadPrompt(
  project: Project,
  title: string,
  memoryIndex: string | undefined,
): string {
  return [
    `You are a thread of the Pi Cloud Project "${project.name}", working on: ${title}.`,
    "Your working directory holds each of the Project's repositories in its own folder, all on your branch.",
    "Use message_coordinator when you need a decision or have a result the coordinator must act on. Don't use it for progress updates or to acknowledge the coordinator's messages: the coordinator already gets a notice with your reply after each of your turns.",
    "End every turn with a short reply that states your result: the coordinator gets it in a notice.",
    "Keep your work state current with set_status: in_progress, blocked, review_ready, done or failed.",
    "Project memory is shared with the coordinator and the other threads: memory_list, memory_read and memory_write.",
    ...projectContext(project, memoryIndex),
  ].join("\n\n");
}

function projectContext(
  project: Project,
  memoryIndex: string | undefined,
): string[] {
  return [
    `Repositories: ${project.repositories.join(", ")}`,
    ...(project.instructions.trim() === ""
      ? []
      : [`## Project instructions\n\n${project.instructions.trim()}`]),
    ...(memoryIndex === undefined || memoryIndex.trim() === ""
      ? []
      : [`## Project memory (MEMORY.md)\n\n${memoryIndex.trim()}`]),
  ];
}

export function runState(session: Session | undefined): RunState {
  if (session?.archivedAt !== null) {
    return "archived";
  }

  if (!session.online) {
    return "offline";
  }

  switch (session.status) {
    case "idle":
      return "idle";
    case "interrupted":
    case "failed":
    case "stopped":
      return "interrupted";
    case "queued":
    case "starting":
    case "running":
      return "working";
  }
}

export function threadNotice(
  thread: Member,
  session: Session | undefined,
  event: string,
  transcript: readonly string[],
): string {
  const reply = lastReply(transcript);

  return [
    `[Project notice] Thread "${thread.title}" (${thread.sessionId}) ${event}. Run state: ${runState(session)}. Work state: ${thread.workState}.`,
    ...(reply === undefined
      ? []
      : [
          `Its last reply: ${reply.length > replyLimit ? `${reply.slice(0, replyLimit)}…` : reply}`,
        ]),
  ].join("\n");
}

interface Entry {
  readonly type: string;
  readonly message?: {
    readonly role: string;
    readonly content:
      string | readonly { type: string; text?: string; name?: string }[];
  };
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

export function messageText(line: string): {
  readonly role: string;
  readonly text: string;
} | null {
  const entry = JSON.parse(line) as Entry;
  if (entry.type !== "message" || entry.message === undefined) {
    return null;
  }

  const { role, content } = entry.message;

  const text =
    typeof content === "string"
      ? content
      : content
          .flatMap((part) => (part.type === "text" ? (part.text ?? []) : []))
          .join("");

  return text.trim() === "" ? null : { role, text: text.trim() };
}

function lastReply(transcript: readonly string[]): string | undefined {
  return transcript
    .map(messageText)
    .findLast((message) => message?.role === "assistant")?.text;
}
