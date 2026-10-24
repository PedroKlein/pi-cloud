// pi-subagents' formats for hosts, version 1 (its docs/observability.md).

export interface RunNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly state: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly activity?: {
    readonly currentTool?: string;
    readonly toolCount?: number;
  };
  readonly agent?: string;
  readonly model?: string;
  readonly children?: readonly RunNode[];
}

export interface Snapshot {
  readonly kind: "pi-subagents.async-status-snapshot";
  readonly version: 1;
  readonly runs: readonly RunNode[];
}

// A run's line in the completion notice pi-subagents adds to the transcript.
export interface Finished {
  readonly runId: string;
  readonly agent?: string;
  readonly status: string;
  readonly durationMs?: number;
}

export interface InspectReply {
  readonly kind: "pi-subagents.inspect-reply";
  readonly version: 1;
  readonly requestId: string;
  readonly task?: string;
  readonly messages?: readonly {
    readonly role: string;
    readonly kind: "text" | "toolCall" | "toolResult";
    readonly text: string;
    readonly name?: string;
    readonly isError?: boolean;
  }[];
  readonly finalOutput?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export type Tone = "running" | "done" | "failed" | "stopped";

export const snapshotKey = "subagent-async";
export const inspectKey = "subagent-inspect";

export function snapshotOf(data: unknown): Snapshot | undefined {
  return isVersion1(data, "pi-subagents.async-status-snapshot")
    ? (data as Snapshot)
    : undefined;
}

export function inspectReplyOf(data: unknown): InspectReply | undefined {
  return isVersion1(data, "pi-subagents.inspect-reply")
    ? (data as InspectReply)
    : undefined;
}

function isVersion1(data: unknown, kind: string): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "kind" in data &&
    data.kind === kind &&
    "version" in data &&
    data.version === 1
  );
}

export function finishedRuns(line: string): readonly Finished[] {
  if (!line.includes('"subagent-notify"')) {
    return [];
  }

  let entry: {
    readonly type?: string;
    readonly customType?: string;
    readonly details?: { readonly runs?: readonly Finished[] };
  };

  try {
    entry = JSON.parse(line) as typeof entry;
  } catch {
    return [];
  }

  return entry.type === "custom_message" &&
    entry.customType === "subagent-notify"
    ? (entry.details?.runs ?? [])
    : [];
}

export interface Launch {
  readonly agent: string;
  readonly task: string;
}

// A call without an action starts work; one with an action, such as status
// or stop, manages runs.
export function launchOf(args: unknown): Launch | undefined {
  if (typeof args !== "object" || args === null || "action" in args) {
    return undefined;
  }

  const { agent, task, workflow } = args as {
    readonly agent?: unknown;
    readonly task?: unknown;
    readonly workflow?: unknown;
  };

  const named = typeof agent === "string" ? agent : undefined;

  return {
    agent: named ?? (workflow === undefined ? "subagent" : "workflow"),
    task: typeof task === "string" ? task : "",
  };
}

export function asyncIdOf(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }

  const { asyncId } = details as { readonly asyncId?: unknown };

  return typeof asyncId === "string" ? asyncId : undefined;
}

const tones: Readonly<Record<string, Tone>> = {
  queued: "running",
  running: "running",
  paused: "stopped",
  complete: "done",
  completed: "done",
  partial: "failed",
  failed: "failed",
  rejected: "failed",
  stopped: "stopped",
};

export function toneOf(state: string): Tone {
  return tones[state] ?? "running";
}

export function stateLabel(state: string): string {
  switch (state) {
    case "complete":
    case "completed":
      return "Done";
    case "partial":
      return "Partly failed";
    default:
      return state.charAt(0).toUpperCase() + state.slice(1);
  }
}

export function steps(run: RunNode): readonly RunNode[] {
  return run.children !== undefined && run.children.length > 0
    ? run.children
    : [run];
}

export function toolCount(run: RunNode): number {
  return steps(run).reduce(
    (sum, step) => sum + (step.activity?.toolCount ?? 0),
    0,
  );
}

export function currentTool(run: RunNode): string | undefined {
  return steps(run).find(({ activity }) => activity?.currentTool !== undefined)
    ?.activity?.currentTool;
}

export function modelOf(run: RunNode): string | undefined {
  const models = new Set(steps(run).flatMap(({ model }) => model ?? []));

  return models.size === 1 ? [...models][0] : undefined;
}

export function runningCount(snapshot: Snapshot | undefined): number {
  return (snapshot?.runs ?? []).filter(
    ({ state }) => toneOf(state) === "running",
  ).length;
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);

  return `${String(minutes)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function inspectCommand(
  requestId: string,
  asyncId: string,
  childId: string | undefined,
): string {
  return [
    "/subagents-inspect-rpc",
    requestId,
    asyncId,
    ...(childId === undefined ? [] : [childId]),
    "--lines 40",
  ].join(" ");
}
