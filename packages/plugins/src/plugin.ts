import type {
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { EventBus } from "./events";
import type {
  Actor,
  CreateSession,
  Environment,
  ModelRef,
  PluginSettings,
  ProfileContent,
  Question,
  QuestionsAnswer,
  Session,
  ToolResult,
  ToolSpec,
} from "@pi-cloud/protocol";

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

// caller is set when a Session's own plugin part sent the request.
export type PluginRoute = (
  request: Request,
  path: string,
  caller: ToolCaller | undefined,
) => Response | Promise<Response>;

type SqlValue = string | number | bigint | null | Uint8Array;

// Tables a plugin creates must be named <plugin>_<table>.
export interface PluginStore {
  readonly exec: (sql: string) => void;
  readonly all: (sql: string, ...params: readonly SqlValue[]) => unknown[];
  readonly run: (sql: string, ...params: readonly SqlValue[]) => void;
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
  readonly events: {
    readonly publish: (event: PluginEvent) => void;
    readonly subscribe: EventBus["subscribe"];
  };
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
  };
  readonly profiles: {
    // Returns the id the plugin starts its Sessions with.
    readonly provide: (key: string, profile: PluginProfile) => string;
  };
  readonly routes: { readonly handle: (route: PluginRoute) => void };
  readonly models: { readonly offer: (offer: ModelOffer) => void };
  readonly store: PluginStore;
  // The plugin's settings as they are now, a default for each it declares
  // (ADR 0036).
  readonly settings: { readonly get: () => PluginSettings };
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
