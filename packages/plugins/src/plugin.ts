import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { EventBus } from "./events";
import type {
  Actor,
  CreateSession,
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

export type PluginRoute = (
  request: Request,
  path: string,
) => Response | Promise<Response>;

// Tables a plugin creates must be named <plugin>_<table>.
export interface PluginStore {
  readonly exec: (sql: string) => void;
  readonly all: (sql: string, ...params: readonly unknown[]) => unknown[];
  readonly run: (sql: string, ...params: readonly unknown[]) => void;
}

export interface ServerPluginContext {
  readonly tools: { readonly register: (tool: ServerTool) => void };
  readonly events: EventBus;
  readonly sessions: {
    readonly start: (request: StartRequest) => Session;
    readonly get: (id: string) => Session | undefined;
    readonly send: (id: string, text: string, actor: Actor) => void;
    readonly transcript: (id: string) => readonly string[];
  };
  readonly routes: { readonly handle: (route: PluginRoute) => void };
  readonly store: PluginStore;
  readonly log: (
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => void;
}

export interface ServerPlugin {
  readonly name: string;
  readonly register: (context: ServerPluginContext) => void;
}

export interface SessionPlugin {
  readonly name: string;
  readonly extension: ExtensionFactory;
}
