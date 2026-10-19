export const protocolVersion = 1;
export const versionHeader = "pi-cloud-protocol";
export const providerHeader = "pi-cloud-provider";

export interface Assignment {
  readonly sessionId: string;
  readonly generation: number;
  readonly cwd: string;
}

export interface Work {
  readonly start: readonly Assignment[];
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

export type LiveEvent =
  | { readonly type: "status"; readonly status: ActivityStatus }
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

export type Command =
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "abort" };

export type SessionStatus = "queued" | "starting" | ActivityStatus;

export interface Session {
  readonly id: string;
  readonly provider: string;
  readonly cwd: string;
  readonly status: SessionStatus;
  readonly generation: number;
  readonly createdAt: string;
}

export interface CreateSession {
  readonly provider: string;
  readonly cwd: string;
}

export type SessionEvent =
  | { readonly type: "entry"; readonly line: number; readonly entry: string }
  | { readonly type: "live"; readonly event: LiveEvent }
  | { readonly type: "session"; readonly session: Session };
