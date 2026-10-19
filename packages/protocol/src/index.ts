export const protocolVersion = 1;
export const versionHeader = "pi-cloud-protocol";
export const providerHeader = "pi-cloud-provider";

export interface Assignment {
  readonly sessionId: string;
  readonly generation: number;
  readonly cwd: string;
}

export interface Attempt {
  readonly sessionId: string;
  readonly generation: number;
}

export interface WorkPoll {
  readonly running: readonly Attempt[];
}

export interface Work {
  readonly start: readonly Assignment[];
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

export type Prompt =
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
  | { readonly type: "abort" }
  | {
      readonly type: "answer";
      readonly id: string;
      readonly value: string | boolean | null;
    }
  | {
      readonly type: "terminal";
      readonly terminalId: string;
      readonly cols: number;
      readonly rows: number;
    };

export interface TerminalResize {
  readonly type: "resize";
  readonly cols: number;
  readonly rows: number;
}

export type SessionStatus =
  "queued" | "starting" | ActivityStatus | "interrupted" | "failed";

export interface Session {
  readonly id: string;
  readonly provider: string;
  readonly cwd: string;
  readonly status: SessionStatus;
  readonly generation: number;
  readonly createdAt: string;
  readonly interruptedAt: string | null;
  readonly error: string | null;
  readonly online: boolean;
}

export interface CreateSession {
  readonly provider: string;
  readonly cwd: string;
}

export type SessionEvent =
  | { readonly type: "entry"; readonly line: number; readonly entry: string }
  | { readonly type: "live"; readonly event: LiveEvent }
  | { readonly type: "session"; readonly session: Session };
