export const protocolVersion = 1;
export const versionHeader = "pi-cloud-protocol";
export const providerHeader = "pi-cloud-provider";

export interface RepositoryCheckout {
  readonly repository: string;
  readonly startPoint?: string;
}

// The directory a repository is checked out into inside a repositories
// Workspace: the last segment of its URL, without ".git". Undefined when that
// is "", "." or "..", which can't name a folder of its own.
export function checkoutName(repository: string): string | undefined {
  const name = repository
    .replace(/[/\\]+$/, "")
    .split(/[/:\\]/)
    .at(-1)
    ?.replace(/\.git$/, "");

  return name === "" || name === "." || name === ".." ? undefined : name;
}

// What a removal records to bring a session branch back (ADR 0013). Only the
// provider sets it, so a WorkspaceRequest has none.
interface Restorable {
  // The remote branch or commit that held the branch's work. Once no remote
  // has it, the branch starts over from startPoint.
  readonly restorePoint?: string;
  // The piCloud* keys of the branch's git config by name, such as the commit
  // it started from and its pull request (ADR 0021). They come back with the
  // branch, but not when it starts over.
  readonly branchConfig?: Readonly<Record<string, string>>;
}

export type Workspace =
  | { readonly kind: "folder"; readonly path: string }
  | ({
      readonly kind: "worktree";
      readonly path: string;
      readonly branch: string;
      readonly startPoint?: string;
    } & Restorable)
  | ({
      readonly kind: "clone";
      readonly repository: string;
      readonly branch: string;
      readonly startPoint?: string;
    } & Restorable)
  | {
      readonly kind: "repositories";
      readonly repositories: readonly (RepositoryCheckout & Restorable)[];
      readonly branch: string;
    };

export type WorkspaceRequest =
  | { readonly kind: "folder"; readonly path: string }
  | {
      readonly kind: "worktree";
      readonly path: string;
      readonly startPoint?: string;
    }
  | {
      readonly kind: "clone";
      readonly repository: string;
      readonly startPoint?: string;
    }
  | {
      readonly kind: "repositories";
      readonly repositories: readonly RepositoryCheckout[];
    };

export interface ModelRef {
  readonly provider: string;
  readonly id: string;
}

export interface Assignment {
  readonly sessionId: string;
  readonly generation: number;
  readonly workspace: Workspace;
  readonly model: ModelRef | null;
  readonly thinking: ThinkingLevel | null;
  readonly systemPrompt: string | null;
  readonly firstMessage: string | null;
  readonly plugins: readonly string[];
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ToolCall {
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

export interface Attempt {
  readonly sessionId: string;
  readonly generation: number;
}

export interface WorkPoll {
  readonly running: readonly Attempt[];
  readonly folders: readonly string[];
  readonly models: readonly ModelRef[];
}

export interface Removal {
  readonly sessionId: string;
  readonly generation: number;
  readonly workspace: Workspace;
  readonly force: boolean;
}

export interface Work {
  readonly start: readonly Assignment[];
  readonly unload: readonly Attempt[];
  readonly remove: readonly Removal[];
}

export type RemovalReport =
  // restore is the Workspace to prepare when the Session comes back, starting
  // from what the remotes still hold of its branch.
  | { readonly outcome: "removed"; readonly restore: Workspace }
  | { readonly outcome: "kept"; readonly reason: string };

// A report as the agent posts it, with the generation of the Removal it
// answers.
export type RemovalPost = RemovalReport & { readonly generation: number };

export interface StartFailure {
  readonly generation: number;
  readonly error: string;
}

export interface TranscriptBatch {
  readonly generation: number;
  readonly start: number;
  readonly lines: readonly string[];
}

export interface TranscriptAck {
  readonly acked: number;
}

export type ActivityStatus = "idle" | "running";

export interface QuestionOption {
  readonly value: string;
  readonly label: string;
  readonly description: string | null;
  readonly recommended: boolean;
}

interface QuestionBase {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
  readonly context: string | null;
}

export type Question =
  | (QuestionBase & {
      readonly type: "single" | "multi" | "scale" | "rank";
      readonly options: readonly QuestionOption[];
    })
  | (QuestionBase & {
      readonly type: "text";
      readonly placeholder: string | null;
    })
  | (QuestionBase & {
      readonly type: "number";
      readonly min: number;
      readonly max: number;
      readonly step: number;
      readonly unit: string | null;
      readonly recommended: number | null;
    });

export interface Selection {
  readonly value: string;
  readonly label: string;
  readonly custom: boolean;
  readonly annotation: string | null;
}

export type QuestionAnswer =
  | {
      readonly id: string;
      readonly type: "choice";
      readonly selections: readonly Selection[];
    }
  | { readonly id: string; readonly type: "text"; readonly text: string }
  | { readonly id: string; readonly type: "number"; readonly value: number };

export interface QuestionsAnswer {
  readonly answers: readonly QuestionAnswer[];
  readonly note: string | null;
}

export type Answer = string | boolean | QuestionsAnswer | null;

export type Prompt =
  | {
      readonly id: string;
      readonly kind: "questions";
      readonly title: string;
      readonly questions: readonly Question[];
      readonly explain: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "confirm";
      readonly title: string;
      readonly message: string;
    }
  | {
      readonly id: string;
      readonly kind: "select";
      readonly title: string;
      readonly options: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: "input" | "secret";
      readonly title: string;
      readonly placeholder: string | null;
    }
  | {
      readonly id: string;
      readonly kind: "editor";
      readonly title: string;
      readonly prefill: string | null;
    };

export type LiveEvent =
  | {
      readonly type: "status";
      readonly status: ActivityStatus;
      // On the idle status that ends a turn: how many transcript lines the
      // turn ended with, which the transcript upload may not have reached yet.
      readonly transcriptLength?: number;
    }
  | { readonly type: "prompt"; readonly prompt: Prompt }
  | { readonly type: "prompt_end"; readonly id: string }
  | {
      readonly type: "notify";
      readonly message: string;
      readonly level: "info" | "warning" | "error";
    }
  | {
      readonly type: "extension_status";
      readonly key: string;
      readonly text: string | null;
    }
  | {
      readonly type: "widget";
      readonly key: string;
      readonly lines: readonly string[] | null;
      readonly placement: "aboveEditor" | "belowEditor";
    }
  | { readonly type: "title"; readonly title: string }
  // What `/` can run, sent when an attempt starts (ADR 0006).
  | { readonly type: "commands"; readonly commands: readonly SlashCommand[] }
  // Workspace paths `@` can mention, at most 5,000 (ADR 0006).
  | {
      readonly type: "files";
      readonly paths: readonly string[];
      readonly truncated: boolean;
    }
  | {
      readonly type: "plugin";
      readonly plugin: string;
      readonly key: string;
      readonly data: unknown;
    }
  | {
      readonly type: "queue";
      readonly steering: readonly string[];
      readonly followUp: readonly string[];
    }
  | { readonly type: "editor_text"; readonly text: string }
  // The Session's model and reasoning level, the levels its model takes
  // (ADR 0023), and the models it has credentials for (ADR 0024).
  | {
      readonly type: "settings";
      readonly model: ModelRef | null;
      readonly thinking: ThinkingLevel;
      readonly levels: readonly ThinkingLevel[];
      readonly models: readonly ModelRef[];
    }
  | {
      readonly type: "explanation";
      readonly id: string;
      readonly questionId: string;
      readonly value: string;
      readonly question: string | null;
      readonly text: string | null;
      readonly error: string | null;
    }
  | { readonly type: "text"; readonly delta: string }
  | {
      readonly type: "tool_start";
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | {
      readonly type: "tool_end";
      readonly toolCallId: string;
      readonly isError: boolean;
    };

// The part of a Session's live state an event sets. A later event with the
// same key replaces it, and a closed surface is no longer shown.
export function liveSurface(
  event: LiveEvent,
): { readonly key: string; readonly open: boolean } | undefined {
  switch (event.type) {
    case "prompt":
      return { key: `prompt:${event.prompt.id}`, open: true };
    case "prompt_end":
      return { key: `prompt:${event.id}`, open: false };
    case "extension_status":
      return { key: `status:${event.key}`, open: event.text !== null };
    case "widget":
      return { key: `widget:${event.key}`, open: event.lines !== null };
    case "title":
      return { key: "title", open: true };
    case "commands":
      return { key: "commands", open: true };
    case "files":
      return { key: "files", open: true };
    case "settings":
      return { key: "settings", open: true };
    case "plugin":
      return { key: `plugin:${event.plugin}:${event.key}`, open: true };
    case "queue":
      return {
        key: "queue",
        open: event.steering.length > 0 || event.followUp.length > 0,
      };
    case "status":
    case "notify":
    case "editor_text":
    case "explanation":
    case "text":
    case "tool_start":
    case "tool_end":
      return undefined;
  }
}

export interface LivePost {
  readonly generation: number;
  readonly events: readonly LiveEvent[];
}

export type Actor = `user:${string}` | `session:${string}` | `plugin:${string}`;

// Pi's reasoning levels, from none to the most a model allows.
export const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof thinkingLevels)[number];

export interface SlashCommand {
  readonly name: string;
  readonly description: string | null;
  readonly source: "builtin" | "extension" | "prompt" | "skill";
}

// Base64 image data sent to the model with a message (ADR 0006).
export interface ImageAttachment {
  readonly mimeType: (typeof imageTypes)[number];
  readonly data: string;
}

export const imageTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export const imageLimits = { count: 5, bytes: 5 * 1024 * 1024 } as const;

export type Command = { readonly actor: Actor } & (
  | {
      readonly type: "message";
      readonly text: string;
      readonly images?: readonly ImageAttachment[];
      readonly requestId?: string;
      readonly delivery?: "steer" | "followUp";
    }
  | { readonly type: "abort" }
  | { readonly type: "set_model"; readonly model: ModelRef }
  | { readonly type: "set_thinking"; readonly level: ThinkingLevel }
  // Takes a queued message back before Pi reads it; the text returns to the
  // composer as editor_text.
  | {
      readonly type: "unqueue";
      readonly delivery: "steer" | "followUp";
      readonly text: string;
    }
  // Context for the model's next turn that doesn't start one.
  | { readonly type: "context"; readonly text: string }
  | { readonly type: "answer"; readonly id: string; readonly value: Answer }
  | {
      readonly type: "tool_result";
      readonly id: string;
      readonly result: ToolResult;
    }
  | {
      readonly type: "explain";
      readonly id: string;
      readonly questionId: string;
      readonly value: string;
      readonly question: string | null;
    }
  | {
      readonly type: "terminal";
      readonly terminalId: string;
      readonly cols: number;
      readonly rows: number;
    }
);

export interface TerminalResize {
  readonly type: "resize";
  readonly cols: number;
  readonly rows: number;
}

export type SessionStatus =
  "queued" | "starting" | ActivityStatus | "interrupted" | "failed" | "stopped";

export type WorkspaceRemoval = "pending" | "forced" | "removed" | "kept";

export interface Session {
  readonly id: string;
  readonly environmentId: string;
  readonly ownerId: string;
  readonly provider: string;
  readonly workspace: Workspace;
  readonly model: ModelRef | null;
  // The reasoning level a new Session starts at. Pi keeps later changes.
  readonly thinking: ThinkingLevel | null;
  readonly systemPrompt: string | null;
  readonly firstMessage: string | null;
  // The name Pi gave the session, or else the first thing the user said.
  readonly title: string | null;
  readonly status: SessionStatus;
  readonly generation: number;
  readonly createdAt: string;
  readonly interruptedAt: string | null;
  readonly error: string | null;
  readonly archivedAt: string | null;
  readonly workspaceRemoval: WorkspaceRemoval | null;
  readonly online: boolean;
}

export interface Environment {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly ownerId: string;
  readonly createdAt: string;
  readonly online: boolean;
  readonly folders: readonly string[];
  readonly models: readonly ModelRef[];
}

export interface CreateSession {
  readonly environment?: string;
  readonly workspace: WorkspaceRequest;
  readonly model?: ModelRef;
  readonly thinking?: ThinkingLevel;
  readonly systemPrompt?: string;
  readonly firstMessage?: string;
}

export type SessionEvent =
  | { readonly type: "entry"; readonly line: number; readonly entry: string }
  | { readonly type: "live"; readonly event: LiveEvent }
  | { readonly type: "session"; readonly session: Session };
