export const protocolVersion = 1;
export const versionHeader = "pi-cloud-protocol";
export const providerHeader = "pi-cloud-provider";

export interface RepositoryCheckout {
  readonly repository: string;
  readonly startPoint?: string;
}

// The directory a repository is checked out into inside a repositories
// Workspace: the last segment of its URL, without ".git".
export function checkoutName(repository: string): string {
  return (
    repository
      .replace(/[/\\]+$/, "")
      .split(/[/:\\]/)
      .at(-1)
      ?.replace(/\.git$/, "") ?? ""
  );
}

export type Workspace =
  | { readonly kind: "folder"; readonly path: string }
  | {
      readonly kind: "worktree";
      readonly path: string;
      readonly branch: string;
      readonly startPoint?: string;
    }
  | {
      readonly kind: "clone";
      readonly repository: string;
      readonly branch: string;
      readonly startPoint?: string;
    }
  | {
      readonly kind: "repositories";
      readonly repositories: readonly RepositoryCheckout[];
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
      readonly kind: "input";
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
  | { readonly type: "status"; readonly status: ActivityStatus }
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

export interface LivePost {
  readonly generation: number;
  readonly events: readonly LiveEvent[];
}

export type Actor = `user:${string}` | `session:${string}` | `plugin:${string}`;

export interface SlashCommand {
  readonly name: string;
  readonly description: string | null;
  readonly source: "extension" | "prompt" | "skill";
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
  readonly systemPrompt: string | null;
  readonly firstMessage: string | null;
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
  readonly systemPrompt?: string;
  readonly firstMessage?: string;
}

export type SessionEvent =
  | { readonly type: "entry"; readonly line: number; readonly entry: string }
  | { readonly type: "live"; readonly event: LiveEvent }
  | { readonly type: "session"; readonly session: Session };
