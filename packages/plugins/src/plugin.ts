import type {
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { EventBus } from "./events";
import type {
  Actor,
  CreateSession,
  Environment,
  GitLogin,
  ModelRef,
  PluginSettings,
  ProfileContent,
  Question,
  QuestionsAnswer,
  Session,
  ToolNamespace,
  ToolResult,
  ToolSpec,
} from "@pipoca/protocol";

export type KernelEvent =
  | {
      readonly type: "SessionCreated";
      readonly session: Session;
      readonly actor: Actor;
    }
  | {
      readonly type: "SessionStateChanged";
      readonly session: Session;
      readonly previous: Session["status"];
    }
  | { readonly type: "TurnStarted"; readonly session: Session }
  | {
      readonly type: "TurnEnded";
      readonly session: Session;
      // How many transcript lines the turn ended with, when the Session's
      // host says. The transcript upload can still be behind it.
      readonly transcriptLength?: number;
    }
  | { readonly type: "SessionArchived"; readonly session: Session }
  | {
      readonly type: "SessionUnarchived";
      readonly session: Session;
      // When the Session was archived.
      readonly archivedAt: string;
    }
  | {
      readonly type: "ToolCalled";
      readonly session: Session;
      readonly tool: string;
      readonly actor: Actor;
    };

export interface PluginEvent {
  readonly type: `${string}.${string}`;
  readonly [field: string]: unknown;
}

export type StartRequest = CreateSession & { readonly actor: Actor };

export interface ToolCaller {
  readonly session: Session;
  readonly actor: Actor;
}

export interface ServerTool extends ToolSpec {
  readonly appliesTo: (session: Session) => boolean;
  readonly run: (input: unknown, caller: ToolCaller) => Promise<ToolResult>;
}

// A group of tools for meta-sessions and MCP clients (ADR 0035). Each tool
// is a request to one of Pipoca's HTTP routes, made as the calling user, so
// it is checked exactly as the same change in the web UI is.
export interface Toolset {
  readonly namespace: ToolNamespace;
  readonly tools: readonly RouteTool[];
}

// Its full name is <namespace>_<name>, since Pi tool names are global.
export interface RouteTool extends Omit<ToolSpec, "namespace"> {
  readonly request: (input: Readonly<Record<string, unknown>>) => RouteRequest;
  // What the model sees of a successful reply's body, such as a list without
  // the fields it doesn't need.
  readonly result?: (body: unknown) => unknown;
  // What to open for the user after a successful call, such as the Session
  // it started. A plugin's routes are relative to its own pages.
  readonly opens?: (
    body: unknown,
  ) => { readonly route: string; readonly label: string } | undefined;
}

// A plugin's tool paths are relative to its own routes; the kernel's start
// at /api/.
export interface RouteRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
}

// Who sent a request to a plugin's routes: a signed-in user, also through a
// toolset tool that acts for them (ADR 0035), or a Session through the
// plugin's own Session part. A route acts as its caller (ADR 0038).
export type RouteCaller =
  | {
      readonly kind: "user";
      readonly actor: `user:${string}`;
      readonly admin: boolean;
    }
  | ({ readonly kind: "session" } & ToolCaller);

export type PluginRoute = (
  request: Request,
  path: string,
  caller: RouteCaller,
) => Response | Promise<Response>;

// Undefined passes the request on to the plugin's routes, which need a
// signed-in user.
export type PublicRoute = (
  request: Request,
  path: string,
) => Response | undefined | Promise<Response | undefined>;

export interface User {
  readonly id: string;
  readonly name: string;
  readonly admin: boolean;
}

// A link on the sign-in page to a path in the plugin's routes.
export interface Login {
  readonly label: string;
  readonly path: string;
}

type SqlValue = string | number | bigint | null | Uint8Array;

// Tables a plugin creates must be named <plugin>_<table>.
export interface PluginStore {
  readonly exec: (sql: string) => void;
  readonly all: (sql: string, ...params: readonly SqlValue[]) => unknown[];
  readonly run: (sql: string, ...params: readonly SqlValue[]) => void;
  // Encrypts a secret to keep in a table, with the server's secret key, like
  // Environment secrets (ADR 0034). The context, such as the row's id, keeps
  // a sealed value from being moved to another row, and another plugin can't
  // open it.
  readonly seal: (text: string, context: string) => string;
  readonly open: (sealed: string, context: string) => string;
}

// The plugin's part of the server's config folder (ADR 0039).
export interface PluginConfig {
  // The plugin's key in the folder's pipoca.json, read again when the file
  // changes, for the plugin to check.
  readonly get: () => unknown;
  // Replaces the plugin's key and leaves the others alone.
  readonly set: (value: unknown) => void;
  // A folder of the plugin's own, which may not exist yet.
  readonly dir: string;
}

// A read-only Profile a plugin ships for the Sessions it owns, such as the
// meta Profile (ADR 0035). Users don't list or edit it.
export interface PluginProfile extends ProfileContent {
  readonly name: string;
}

// Models a plugin offers for an Environment: listed before the machine's own
// in model fields, and a default for Sessions that name none.
export interface OfferedModels {
  readonly models: readonly ModelRef[];
  readonly default?: ModelRef;
}

export type ModelOffer = (environmentId: string) => OfferedModels;

// offline means the Session's host isn't connected right now, so a later send
// can still reach it.
export type SendOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "archived" | "offline";
    };

export interface PluginNotice {
  readonly kind: string;
  readonly data?: unknown;
}

export interface ServerPluginContext {
  // The user this installation belongs to. v1 has exactly one.
  readonly owner: string;
  readonly tools: { readonly register: (tool: ServerTool) => void };
  readonly toolsets: {
    readonly register: (toolset: Toolset) => void;
    // Every plugin's toolsets load in the Sessions this plugin owns, as the
    // meta plugin's do.
    readonly loadInOwnSessions: () => void;
  };
  readonly events: {
    readonly publish: (event: PluginEvent) => void;
    readonly subscribe: EventBus["subscribe"];
  };
  // Tells open pages that something of the plugin's changed. They hear it as
  // the topic "<plugin>.<name>" and fetch again (ADR 0038).
  readonly changes: { readonly publish: (name: string) => void };
  readonly sessions: {
    // With an owner key the plugin owns the Session: it stays out of the
    // Session list and opens where the plugin's web part says (ADR 0028).
    readonly start: (request: StartRequest, ownerKey?: string) => Session;
    readonly get: (id: string) => Session | undefined;
    // The Sessions this plugin owns under the key, newest first.
    readonly owned: (
      ownerKey: string,
      options?: { readonly archived?: boolean },
    ) => readonly Session[];
    // The Session plugins that load in the Sessions this plugin owns, by
    // name. All of them load until the plugin says.
    readonly loadOnly: (plugins: readonly string[]) => void;
    // Takes ownership of a Session started before owners existed.
    readonly adopt: (id: string, ownerKey: string) => void;
    // Archive or bring back a Session this plugin owns, such as every
    // Session of one owner key at once (ADR 0028).
    readonly archive: (id: string) => void;
    readonly unarchive: (id: string) => void;
    // Starts a turn, or queues as a follow-up when the Session is busy.
    // With a notice, the web draws it with this plugin's renderer for the
    // notice's kind (ADR 0028).
    readonly send: (
      id: string,
      text: string,
      actor: Actor,
      notice?: PluginNotice,
    ) => SendOutcome;
    // Adds context the Session reads on its next turn, without starting one.
    readonly notify: (
      id: string,
      text: string,
      actor: Actor,
      notice?: PluginNotice,
    ) => SendOutcome;
    readonly transcript: (id: string) => readonly string[];
    readonly transcriptLength: (id: string) => number;
  };
  // For a plugin that brings machines to a pool, such as Kubernetes pods
  // (ADR 0032).
  readonly environments: {
    readonly list: () => readonly Environment[];
    // Sessions no online runner in the pool can take now: queued ones beyond
    // the room its runners have, and ones held by a runner that went away.
    readonly unplaced: (environmentId: string) => readonly Session[];
    // The token a runner the plugin starts polls with. It lasts until revoked,
    // and a new Environment key leaves it be.
    readonly runnerToken: (environmentId: string, runner: string) => string;
    readonly revokeRunner: (environmentId: string, runner: string) => void;
    // Says which Environments the plugin starts runners for on demand, so
    // they don't read as offline while none is running.
    readonly startsRunners: (
      starts: (environmentId: string) => boolean,
    ) => void;
  };
  readonly profiles: {
    // Returns the id the plugin starts its Sessions with.
    readonly provide: (key: string, profile: PluginProfile) => string;
  };
  readonly routes: { readonly handle: (route: PluginRoute) => void };
  // For a built-in plugin that signs people in without a password, such as
  // OIDC (ADR 0038). Installed plugins don't get it.
  readonly auth: {
    // Asked each time the sign-in page loads, so a plugin that isn't set up
    // yet offers nothing.
    readonly offer: (logins: () => readonly Login[]) => void;
    // Tried before the plugin's own routes, for every browser, signed in or
    // not, such as an identity provider redirecting back.
    readonly handlePublic: (route: PublicRoute) => void;
    readonly userOf: (request: Request) => User | undefined;
    // A user who signs in only through the plugin, or undefined when the
    // name is taken.
    readonly createUser: (name: string, admin: boolean) => User | undefined;
    readonly setAdmin: (userId: string, admin: boolean) => void;
    // The Set-Cookie value of a new browser session for the user, or
    // undefined when no user has the id.
    readonly startSession: (
      userId: string,
      request: Request,
    ) => string | undefined;
    // The git hosts a user connected, which the runner signs in to for the
    // user's Sessions (ADR 0043).
    readonly gitLogins: (
      logins: (userId: string) => readonly GitLogin[],
    ) => void;
  };
  readonly models: { readonly offer: (offer: ModelOffer) => void };
  readonly store: PluginStore;
  // The plugin's settings as they are now, a default for each it declares
  // (ADR 0036).
  readonly settings: { readonly get: () => PluginSettings };
  readonly config: PluginConfig;
  // Aborted when the server stops, or when the plugin fails to register.
  readonly signal: AbortSignal;
  readonly log: (
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => void;
}

export interface ServerPlugin {
  readonly name: string;
  readonly register: (context: ServerPluginContext) => void;
}

export type Explain = (
  questionId: string,
  value: string,
  question: string | null,
) => Promise<string>;

export type AskQuestions = (
  questions: readonly Question[],
  explain: Explain | undefined,
  signal: AbortSignal | undefined,
) => Promise<QuestionsAnswer | null>;

// A git checkout in the Session's workspace, and the commit its session
// branch started from when it has one.
export interface Checkout {
  readonly path: string;
  readonly base: string | null;
}

// What the session host gives a plugin's Pi extension beyond Pi's own API.
export interface SessionCloud {
  // Replaces the plugin's last value under key for everyone watching the
  // Session, and for anyone who opens it later.
  readonly publish: (key: string, data: unknown) => void;
  readonly askQuestions: AskQuestions;
  readonly checkouts: readonly Checkout[];
  // The plugin's settings when the Session started (ADR 0036).
  readonly settings: PluginSettings;
  // Sends a request to the plugin's own server routes as this Session.
  readonly request: (path: string, init?: RequestInit) => Promise<Response>;
  readonly log: (
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => void;
}

export interface SessionPlugin {
  readonly name: string;
  // Loads only in the Sessions the server plugin of the same name owns.
  readonly ownSessionsOnly?: boolean;
  readonly extension?: (cloud: SessionCloud) => ExtensionFactory;
  // Pi packages, such as npm:<name>@<version>, loaded in every Session. Pi
  // installs each on first use. A user's own extension that registers the same
  // tool or command replaces it.
  readonly packages?: readonly string[];
  // Tools that replace any extension tool of the same name, asked for once
  // when the Session starts.
  readonly tools?: (
    cloud: SessionCloud,
  ) => readonly ToolDefinition[] | Promise<readonly ToolDefinition[]>;
}
