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

export type Command =
  | {
      readonly type: "message";
      readonly text: string;
      readonly requestId?: string;
    }
  | { readonly type: "abort" }
  | { readonly type: "answer"; readonly id: string; readonly value: Answer }
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
