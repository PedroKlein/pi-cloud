export const workStates = [
  "in_progress",
  "blocked",
  "review_ready",
  "done",
  "failed",
] as const;

export type WorkState = (typeof workStates)[number];

export type RunState =
  "working" | "idle" | "offline" | "interrupted" | "archived";

export type Role = "coordinator" | "thread";

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly coordinatorId: string;
  readonly coordinatorState: RunState;
  readonly repositories: number;
  readonly threads: number;
  readonly blocked: number;
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

export interface MemoryFileView {
  readonly name: string;
  readonly size: number;
  readonly updatedAt: string;
  readonly actor: string;
}

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly repositories: readonly string[];
  readonly environmentId: string | null;
  readonly threadModel: string | null;
  readonly coordinatorId: string;
  readonly coordinatorState: RunState;
  readonly coordinatorSays: string | null;
  readonly threads: readonly ThreadView[];
  readonly memory: readonly MemoryFileView[];
}
