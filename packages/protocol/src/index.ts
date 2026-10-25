export const protocolVersion = 2;
export const versionHeader = "pi-cloud-protocol";

// A runner joins the pool of the Environment whose key it holds, under a name
// of its own, and gets a token for its other calls (ADR 0033).
export interface JoinRequest {
  readonly name: string;
}

export interface Joined {
  readonly token: string;
  // The provider name of the Environment it joined.
  readonly environment: string;
}

// The key is shown once. Runners that joined with an Environment's earlier
// key are let go.
export interface EnvironmentKey {
  readonly key: string;
}

// A runner's lease on its Sessions lasts this long after its last poll. Then
// a Session whose Workspace can be made again elsewhere moves to another
// runner, so a runner that can't poll stops those Sessions well before
// (ADR 0032).
export const leaseMs = 60_000;

export function movable(workspace: Workspace): boolean {
  return workspace.kind === "clone" || workspace.kind === "repositories";
}

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

// A Pi package source as Pi's settings take it, with Pi's optional filters
// for which of its resources load.
export type PiPackage =
  | string
  | {
      readonly source: string;
      readonly autoload?: boolean;
      readonly extensions?: readonly string[];
      readonly skills?: readonly string[];
      readonly prompts?: readonly string[];
      readonly themes?: readonly string[];
    };

// What a Profile holds: a Pi agent directory without credentials (ADR 0031).
// An empty text leaves its file out.
export interface ProfileContent {
  readonly packages: readonly PiPackage[];
  readonly agentsMd: string;
  readonly systemMd: string;
  readonly appendSystemMd: string;
  readonly mcpServers: Readonly<Record<string, unknown>>;
  // Pi settings, such as defaultModel, other than packages.
  readonly settings: Readonly<Record<string, unknown>>;
}

export const emptyProfile: ProfileContent = {
  packages: [],
  agentsMd: "",
  systemMd: "",
  appendSystemMd: "",
  mcpServers: {},
  settings: {},
};

export interface Profile extends ProfileContent {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  readonly createdAt: string;
  // New Sessions use the default Profile when nothing else names one.
  readonly isDefault: boolean;
}

// The file a Profile is exported to and imported from.
export interface ProfileExport extends ProfileContent {
  readonly piCloudProfile: 1;
  readonly name: string;
}

export interface Assignment {
  readonly sessionId: string;
  readonly generation: number;
  readonly profile: ProfileContent & { readonly id: string };
  readonly workspace: Workspace;
  // Whether the user trusts the repository's own Pi configuration in .pi, or
  // null when nobody was asked yet (ADR 0031).
  readonly trusted: boolean | null;
  readonly model: ModelRef | null;
  readonly thinking: ThinkingLevel | null;
  readonly systemPrompt: string | null;
  readonly firstMessage: string | null;
  readonly plugins: readonly string[];
  readonly environment: SessionEnvironment;
}

// A Session runs as a process on its runner's machine, or as a process in a
// container from the Environment's image (ADR 0032).
export const isolations = ["process", "container"] as const;
export type Isolation = (typeof isolations)[number];

// What a Session's Environment sets up on its machine (ADR 0032). The
// variables hold the Environment's secrets too.
export interface SessionEnvironment {
  readonly isolation: Isolation;
  readonly image: string | null;
  readonly setupScript: string;
  readonly variables: Readonly<Record<string, string>>;
}

// How the model reaches a tool, as Pi's tool exposure has it: deferred and
// codemode tools are found through tool_search and codemode scripts.
export type ToolExposure = "direct" | "deferred" | "codemode";

// A group of related tools, as Pi's tool namespaces have it.
export interface ToolNamespace {
  readonly name: string;
  readonly description?: string;
  readonly instructions?: string;
}

// Hints about what a tool does, with the meaning of MCP tool annotations.
// A missing hint takes the unsafe value.
export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly exposure?: ToolExposure;
  readonly namespace?: ToolNamespace;
  readonly annotations?: ToolAnnotations;
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
  // How many Sessions the runner takes at once. Absent means no limit.
  readonly capacity?: number;
  // A runner started for one Session, such as a pod on that Session's own
  // volume, takes only that Session, and that Session goes only to it.
  readonly session?: string;
}

export interface Removal {
  readonly sessionId: string;
  readonly generation: number;
  readonly workspace: Workspace;
  readonly force: boolean;
}

// A Session's own calls use its token, which reaches only that Session.
export interface SessionStart extends Assignment {
  readonly token: string;
}

export interface Work {
  readonly start: readonly SessionStart[];
  readonly unload: readonly Attempt[];
  readonly remove: readonly Removal[];
  // Every Profile's id, so runners can delete the folders of the others.
  readonly profiles: readonly string[];
}

export type RemovalReport =
  // restore is the Workspace to prepare when the Session comes back, starting
  // from what the remotes still hold of its branch.
  | { readonly outcome: "removed"; readonly restore: Workspace }
  | { readonly outcome: "kept"; readonly reason: string };

// A report as the agent posts it, with the generation of the Removal it
// answers.
export type RemovalPost = RemovalReport & { readonly generation: number };

export interface TrustAnswer {
  readonly generation: number;
  readonly trusted: boolean;
}

// The repository a workspace's project trust is kept for: a clone's URL or a
// local checkout's path. A repositories Workspace runs Pi in a folder of
// checkouts, which has no .pi of its own.
export function trustedRepository(workspace: Workspace): string | undefined {
  switch (workspace.kind) {
    case "clone":
      return workspace.repository;
    case "folder":
    case "worktree":
      return workspace.path;
    case "repositories":
      return undefined;
  }
}

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
  // The Session's shells that are still running (ADR 0026).
  | { readonly type: "terminals"; readonly terminals: readonly TerminalTab[] }
  // Whether a browser shows Pi's TUI, which then takes the dialogs, and the
  // dialog open in it (ADR 0027).
  | {
      readonly type: "pi_view";
      readonly attached: boolean;
      readonly dialog: string | null;
    }
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
  // What an extension wrote for hosts in a text widget line
  // PI_<NAME>_JSON:<json>, or null once the widget is gone (ADR 0030).
  | {
      readonly type: "extension_data";
      readonly key: string;
      readonly name: string;
      readonly data: unknown;
    }
  // An extension's footer, which replaces the statuses row, and header, as
  // rendered lines with their SGR escape codes (ADR 0029).
  | { readonly type: "footer"; readonly lines: readonly string[] | null }
  | { readonly type: "header"; readonly lines: readonly string[] | null }
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
    case "extension_data":
      return { key: `data:${event.key}`, open: event.data !== null };
    case "footer":
    case "header":
      return { key: event.type, open: event.lines !== null };
    case "title":
      return { key: "title", open: true };
    case "commands":
      return { key: "commands", open: true };
    case "files":
      return { key: "files", open: true };
    case "terminals":
      return { key: "terminals", open: event.terminals.length > 0 };
    case "pi_view":
      return { key: "pi_view", open: event.attached || event.dialog !== null };
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
  // How many columns the web has for extensions' widgets, footer and header
  // (ADR 0029).
  | { readonly type: "ui_columns"; readonly columns: number }
  // Takes a queued message back before Pi reads it; the text returns to the
  // composer as editor_text. With sendNow it moves to the steering queue
  // instead, so Pi reads it after its current step.
  | {
      readonly type: "unqueue";
      readonly delivery: "steer" | "followUp";
      readonly text: string;
      readonly sendNow?: boolean;
    }
  // Context for the model's next turn that doesn't start one.
  | { readonly type: "context"; readonly text: string }
  // A plugin's notice to the model, which the web draws with the plugin's
  // own renderer (ADR 0028). With turn it starts a turn, or waits as a
  // follow-up while one runs.
  | {
      readonly type: "notice";
      readonly text: string;
      readonly notice: NoticeTag;
      readonly turn: boolean;
    }
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

// The custom message type that carries a NoticeTag in its details.
export const noticeType = "pi-cloud-notice";

export interface NoticeTag {
  readonly plugin: string;
  readonly kind: string;
  readonly data?: unknown;
}

// The terminal id that opens Pi's own TUI instead of a shell (ADR 0027).
export const piTerminal = "pi";

// The close reason a terminal socket gets when another browser opens the same
// terminal. Reopening it then would only take it back.
export const terminalTakenOver = "opened elsewhere";

export interface TerminalTab {
  readonly id: string;
  readonly label: string;
}

// The text frames a browser sends on a terminal socket. Closing the socket
// leaves the shell running; a close frame ends it (ADR 0026).
export type TerminalControl = TerminalResize | { readonly type: "close" };

export interface TerminalResize {
  readonly type: "resize";
  readonly cols: number;
  readonly rows: number;
}

export type SessionStatus =
  "queued" | "starting" | ActivityStatus | "interrupted" | "failed" | "stopped";

export type WorkspaceRemoval = "pending" | "forced" | "removed" | "kept";

// The plugin that started a Session and keeps it out of the Session list
// (ADR 0028), with the plugin's own key, such as a Project's id.
export interface SessionOwner {
  readonly plugin: string;
  readonly key: string;
}

export interface Session {
  readonly id: string;
  readonly environmentId: string;
  readonly ownerId: string;
  readonly owner: SessionOwner | null;
  readonly provider: string;
  // The runner that claimed the Session last, null until one does.
  readonly runner: string | null;
  // Fixed when the Session is created (ADR 0031).
  readonly profileId: string;
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
  // Why the provider kept the workspace, while workspaceRemoval is "kept".
  readonly workspaceKeptReason: string | null;
  readonly online: boolean;
  // Pi asked a question and waits for a person to answer it (ADR 0025).
  readonly waiting: boolean;
}

export interface Runner {
  readonly name: string;
  readonly online: boolean;
  readonly capacity: number | null;
  readonly running: number;
}

// Runners join an Environment's pool by its provider name (ADR 0032).
export interface Environment {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly ownerId: string;
  readonly createdAt: string;
  readonly online: boolean;
  readonly runners: readonly Runner[];
  readonly folders: readonly string[];
  readonly models: readonly ModelRef[];
  readonly isolation: Isolation;
  // Null runs containers from the default image.
  readonly image: string | null;
  // Runs once on each machine, or in each image, before its first Session
  // (ADR 0032).
  readonly setupScript: string;
  readonly variables: Readonly<Record<string, string>>;
  // Secret values never leave the server except in a Session's assignment.
  readonly secrets: readonly string[];
  // Whether runners can join, which takes the Environment's key.
  readonly hasKey: boolean;
}

export interface CreateEnvironment {
  readonly name: string;
}

// A null secret removes it.
export interface EnvironmentUpdate {
  readonly name?: string;
  readonly isolation?: Isolation;
  readonly image?: string | null;
  readonly setupScript?: string;
  readonly variables?: Readonly<Record<string, string>>;
  readonly secrets?: Readonly<Record<string, string | null>>;
}

export interface CreateSession {
  readonly environment?: string;
  readonly profile?: string;
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
