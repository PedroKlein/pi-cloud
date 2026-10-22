import type {
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { EventBus } from "./events";
import type {
  Actor,
  CreateSession,
  ModelRef,
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
  | { readonly type: "TurnEnded"; readonly session: Session }
  | { readonly type: "SessionArchived"; readonly session: Session }
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

// Tables a plugin creates must be named <plugin>_<table>.
export interface PluginStore {
  readonly exec: (sql: string) => void;
  readonly all: (sql: string, ...params: readonly unknown[]) => unknown[];
  readonly run: (sql: string, ...params: readonly unknown[]) => void;
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

export interface ServerPluginContext {
  // The user this installation belongs to. v1 has exactly one.
  readonly owner: string;
  readonly tools: { readonly register: (tool: ServerTool) => void };
  readonly events: EventBus;
  readonly sessions: {
    readonly start: (request: StartRequest) => Session;
    readonly get: (id: string) => Session | undefined;
    // Starts a turn, or queues as a follow-up when the Session is busy.
    readonly send: (id: string, text: string, actor: Actor) => SendOutcome;
    // Adds context the Session reads on its next turn, without starting one.
    readonly notify: (id: string, text: string, actor: Actor) => SendOutcome;
    readonly transcript: (id: string) => readonly string[];
  };
  readonly routes: { readonly handle: (route: PluginRoute) => void };
  readonly models: { readonly offer: (offer: ModelOffer) => void };
  readonly store: PluginStore;
  // Aborted when the server stops.
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
  // Tools that replace any extension tool of the same name, asked for once
  // when the Session starts.
  readonly tools?: (
    cloud: SessionCloud,
  ) => readonly ToolDefinition[] | Promise<readonly ToolDefinition[]>;
}
