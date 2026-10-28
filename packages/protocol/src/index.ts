export const protocolVersion = 4;
export const versionHeader = "pipoca-protocol";

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

// What the UI says about an Environment: a runner is online, a plugin starts
// one when a Session needs it, or none can take a Session now (ADR 0040).
export function availability(
  environment: Pick<Environment, "online" | "onDemand">,
): "Online" | "Starts runners on demand" | "Offline" {
  if (environment.online) {
    return "Online";
  }

  return environment.onDemand ? "Starts runners on demand" : "Offline";
}

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
  // The pipoca* keys of the branch's git config by name, such as the commit
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

// A Pi agent folder in the server's config folder, named by its id
// (ADR 0041).
export interface Profile extends ProfileContent {
  readonly id: string;
  readonly name: string;
  // Null for a Profile shared with every user, which only admins change.
  readonly ownerId: string | null;
  readonly createdAt: string;
  // New Sessions use the default Profile when nothing else names one.
  readonly isDefault: boolean;
}

// The file a Profile is exported to and imported from.
export interface ProfileExport extends ProfileContent {
  readonly pipocaProfile: 1;
  readonly name: string;
}

// Pipoca's own file, and what each machine keeps for itself: logins,
// Session history and installed packages (ADR 0041).
const machineOwned = new Set([
  "profile.json",
  "auth.json",
  "models.json",
  "models-store.json",
  "sessions",
  "git",
  "npm",
  "tmp",
]);

// Whether a path, with / between its parts, is one a Profile folder holds.
export function profilePath(path: string): boolean {
  const parts = path.split("/");

  return (
    parts.every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        part !== "node_modules" &&
        part !== ".git" &&
        !part.endsWith(".tmp"),
    ) && !machineOwned.has(parts[0] ?? "")
  );
}

// A Profile folder's files by their path in it, base64 encoded, and a hash
// of them all, which runners compare with their copy's (ADR 0041).
export interface ProfileFiles {
  readonly hash: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface Assignment {
  readonly sessionId: string;
  readonly generation: number;
  readonly profile: { readonly id: string; readonly hash: string };
  readonly workspace: Workspace;
  // Whether the user trusts the repository's own Pi configuration in .pi, or
  // null when nobody was asked yet (ADR 0031).
  readonly trusted: boolean | null;
  readonly model: ModelRef | null;
  readonly thinking: ThinkingLevel | null;
  readonly systemPrompt: string | null;
  readonly firstMessage: string | null;
  readonly plugins: readonly string[];
  // Each plugin's settings when the Session started (ADR 0036). Older
  // servers leave it out, and Session parts get their defaults.
  readonly pluginSettings?: Readonly<Record<string, PluginSettings>>;
  // Session parts the Session must not run without, such as the meta
  // plugin's confirm. A runner that lacks one doesn't start it.
  readonly requiredPlugins?: readonly string[];
  // The installed plugins' Session parts, by name, with the SHA-256 of each
  // bundle. The runner fetches one it hasn't got (ADR 0022). They are
  // required too, so a runner from before them doesn't start the Session.
  readonly installedParts?: Readonly<Record<string, string>>;
  readonly environment: SessionEnvironment;
  // The git hosts the Session's owner connected (ADR 0043). Older servers
  // leave it out.
  readonly gitLogins?: readonly GitLogin[];
}

export interface GitLogin {
  readonly host: string;
  readonly token: string;
}

// A repository New Session offers (ADR 0043).
export interface RepositoryChoice {
  // What git clones.
  readonly url: string;
  readonly name: string;
  // The heading it is listed under, such as its host.
  readonly group: string;
}

export type SettingValue = string | number | boolean | readonly string[];

export type PluginSettings = Readonly<Record<string, SettingValue>>;

// A setting a plugin declares in its manifest (ADR 0036).
export type SettingSpec = {
  readonly title: string;
  readonly description?: string;
} & (
  | { readonly type: "string"; readonly default: string }
  | {
      readonly type: "number";
      readonly default: number;
      readonly min?: number;
      readonly max?: number;
    }
  | { readonly type: "boolean"; readonly default: boolean }
  | {
      readonly type: "choice";
      readonly options: readonly string[];
      readonly default: string;
    }
  | { readonly type: "strings"; readonly default: readonly string[] }
);

// What an installed plugin's server part may reach on its context besides
// its own store, settings, signal and log (ADR 0022). Built-in plugins reach
// all of it.
export const capabilities = [
  "tools",
  "toolsets",
  "events",
  "sessions",
  "environments",
  "profiles",
  "routes",
  "models",
] as const;

export type Capability = (typeof capabilities)[number];

// The plugin interface an installed plugin is written for. It changes only
// when something a plugin can reach goes away or changes meaning (ADR 0036).
export const pluginEngine = 1;

// The pipoca field of a plugin's package.json (ADR 0022, ADR 0036).
export interface PluginManifest {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly settings?: Readonly<Record<string, SettingSpec>>;
  readonly version?: string;
  readonly engine?: number;
  // Paths inside the plugin's folder.
  readonly parts?: {
    readonly server?: string;
    readonly web?: string;
    readonly session?: string;
  };
  readonly capabilities?: readonly Capability[];
  // An installed plugin's Session part loads only in the Sessions its server
  // part owns. A built-in says so on its Session part instead.
  readonly ownSessionsOnly?: boolean;
}

// A plugin as the Plugins page shows it. A failed plugin's server part threw
// while it loaded or registered, so the plugin is off until the server
// restarts. turnedOn is whether it will be on after the next restart.
export interface PluginInfo extends PluginManifest {
  readonly source: "built-in" | "installed";
  readonly state: "on" | "off" | "failed";
  readonly turnedOn: boolean;
  readonly error?: string;
  readonly values: PluginSettings;
  // Where the shell loads an installed plugin's web part from.
  readonly webPart?: string;
  // The git repository or tarball it was installed from, and the commit or
  // SHA-256 of the version fetched.
  readonly installedFrom?: { readonly url: string; readonly pinned: string };
  // A newer version was fetched, which runs when the server restarts.
  readonly updated?: boolean;
  // Of the manifest shown, so turning the plugin on can say which one the
  // user trusted.
  readonly digest: string;
}

export interface PluginUpdate {
  readonly settings?: PluginSettings;
  // Only an installed plugin can be turned on or off, or updated, here.
  readonly enabled?: boolean;
  readonly digest?: string;
  readonly update?: true;
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
  // The models logged in on the runner, and every model its providers
  // register, logged in or not (ADR 0044).
  readonly models: readonly ModelRef[];
  readonly registeredModels?: readonly ModelRef[];
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

// What a meta-session's tool asks the browsers watching it to do (ADR 0035):
// open a route of the web app, such as a Session's id or plugin/projects/<id>.
export interface UiAction {
  readonly kind: "open";
  readonly route: string;
  readonly label: string;
}

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
  // What the Session asked to open in a browser (ADR 0037).
  | { readonly type: "pages"; readonly pages: readonly OpenedPage[] }
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
  // Sent by the server, never by a runner, and not replayed.
  | { readonly type: "ui_action"; readonly action: UiAction }
  // The Session's model and reasoning level, the levels its model takes
  // (ADR 0023), and the models it has credentials for (ADR 0024).
  | {
      readonly type: "settings";
      readonly model: ModelRef | null;
      readonly thinking: ThinkingLevel;
      readonly levels: readonly ThinkingLevel[];
      readonly models: readonly ModelRef[];
    }
  // Pi's estimate of how much of the model's context the Session fills,
  // with no tokens while Pi can't tell, such as after a compaction (ADR 0038).
  | {
      readonly type: "context";
      readonly tokens: number | null;
      readonly window: number;
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
    case "pages":
      return { key: "pages", open: event.pages.length > 0 };
    case "pi_view":
      return { key: "pi_view", open: event.attached || event.dialog !== null };
    case "settings":
      return { key: "settings", open: true };
    case "context":
      return { key: "context", open: true };
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
    case "ui_action":
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
  // A browser's request to a preview, which the Session host picks up on
  // its own socket (ADR 0037).
  | {
      readonly type: "preview";
      readonly connectionId: string;
      readonly port: number;
    }
  | { readonly type: "close_page"; readonly id: string }
);

// The custom message type that carries a NoticeTag in its details.
export const noticeType = "pipoca-notice";

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

export interface OpenedPage {
  readonly id: string;
  readonly url: string;
}

// The port of a page on the Session's own machine, which only a preview
// reaches.
export function previewPort(url: string): number | undefined {
  if (!URL.canParse(url)) {
    return undefined;
  }

  const { protocol, hostname, port } = new URL(url);
  if (protocol !== "http:" || !loopbackNames.has(hostname)) {
    return undefined;
  }

  return port === "" ? 80 : Number(port);
}

const loopbackNames = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

// A browser's request as the server sends it to the Session host over a
// preview socket. The body follows as one binary frame. A WebSocket's frames
// follow its answer's head instead, both ways.
export interface PreviewRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly websocket?: boolean;
}

// The answer's head, which the Session host sends first. Binary frames with
// the body follow, and a normal close ends it.
export interface PreviewResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
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
  // The user who started the Session, or the one who started the Session
  // that started it. Its runner signs git in as them (ADR 0043).
  readonly startedBy: string | null;
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
  // A plugin starts runners for it when a Session needs one, such as
  // Kubernetes pods, so it takes Sessions with no runner online (ADR 0040).
  readonly onDemand: boolean;
  readonly runners: readonly Runner[];
  readonly folders: readonly string[];
  // The models logged in on its online runners, and every model any of its
  // runners reported, kept after they go (ADR 0044).
  readonly models: readonly ModelRef[];
  readonly registeredModels: readonly ModelRef[];
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
