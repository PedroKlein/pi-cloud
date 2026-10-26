export const workStates = [
  "in_progress",
  "blocked",
  "review_ready",
  "done",
  "failed",
] as const;

export type WorkState = (typeof workStates)[number];

export type RunState =
  "working" | "waiting" | "idle" | "offline" | "interrupted" | "archived";

export type Role = "coordinator" | "thread";

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly coordinatorId: string;
  readonly coordinatorState: RunState;
  readonly repositories: number;
  readonly threads: number;
  // Threads that are blocked or wait on an answer.
  readonly needsYou: number;
}

export interface ThreadView {
  readonly sessionId: string;
  readonly title: string;
  readonly runState: RunState;
  readonly workState: WorkState;
  readonly environmentId: string;
  readonly branch: string | null;
  readonly lastActivity: string;
}

export interface ThreadLinkView extends ThreadView {
  readonly projectId: string;
}

export interface MemoryFileView {
  readonly name: string;
  readonly size: number;
  readonly updatedAt: string;
  readonly actor: string;
}

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly instructions: string;
  readonly repositories: readonly string[];
  readonly environmentId: string | null;
  readonly profileId: string | null;
  readonly threadModel: string | null;
  readonly coordinatorId: string;
  readonly coordinatorState: RunState;
  readonly threads: readonly ThreadView[];
  readonly memory: readonly MemoryFileView[];
}

// The data of each notice a Project chat draws, by kind (ADR 0028).
export interface ProjectNotices {
  readonly thread: {
    readonly threadId: string;
    readonly title: string;
    readonly event: string;
    readonly runState: RunState;
    readonly workState: WorkState;
    readonly reply?: string;
  };
  readonly thread_message: {
    readonly threadId: string;
    readonly title: string;
    readonly text: string;
  };
  readonly coordinator_message: { readonly text: string };
}

export type ProjectNotice = {
  readonly [K in keyof ProjectNotices]: {
    readonly kind: K;
    readonly data: ProjectNotices[K];
  };
}[keyof ProjectNotices];
