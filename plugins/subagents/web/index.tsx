import type {
  MountedSession,
  ToolCall,
  ToolCallProps,
  WebPlugin,
  WidgetProps,
} from "@pipoca/plugins/web";
import type { SessionEvent } from "@pipoca/protocol";
import { cn, Icon } from "@pipoca/ui";
import { type ReactElement, useEffect, useState } from "react";
import {
  asyncIdOf,
  currentTool,
  elapsed,
  type Finished,
  finishedRuns,
  followRun,
  inspectCommand,
  inspectKey,
  type InspectReply,
  inspectReplyOf,
  type Launch,
  launchOf,
  modelOf,
  type RunNode,
  runningCount,
  type Snapshot,
  snapshotKey,
  snapshotOf,
  stateLabel,
  steps,
  type Tone,
  toneOf,
  toolCount,
  transcriptOf,
} from "./runs";

// Subagent runs as cards in the chat, and a chip while any run (ADR 0030).
export const subagents: WebPlugin = {
  name: "subagents",
  tools: { subagent: SubagentCall },
  widgets: { "subagent-fleet-status": RunningChip },
};

function SubagentCall({ call, session }: ToolCallProps): ReactElement {
  const launch = launchOf(call.args);

  return launch ? (
    <RunCard call={call} launch={launch} session={session} />
  ) : (
    <ManageRow call={call} />
  );
}

function extensionData(event: SessionEvent, key: string): unknown {
  return event.type === "live" &&
    event.event.type === "extension_data" &&
    event.event.key === key
    ? event.event.data
    : undefined;
}

// The run as last seen in the live snapshot, which drops runs once they end,
// and its line in the completion notice.
function useRun(
  session: MountedSession,
  asyncId: string | undefined,
): { readonly run?: RunNode; readonly finished?: Finished } {
  const [run, setRun] = useState<RunNode>();
  const [finished, setFinished] = useState<Finished>();

  useEffect(() => {
    if (asyncId === undefined) {
      return undefined;
    }

    return session.events((event) => {
      if (event.type === "entry") {
        const line = finishedRuns(event.entry).find(
          ({ runId }) => runId === asyncId,
        );

        if (line) {
          setFinished(line);
        }

        return;
      }

      const found = snapshotOf(extensionData(event, snapshotKey))?.runs.find(
        ({ id }) => id === asyncId,
      );

      if (found) {
        setRun((seen) => followRun(seen, found));
      }
    });
  }, [session, asyncId]);

  return { ...(run && { run }), ...(finished && { finished }) };
}

function useSnapshot(session: MountedSession): Snapshot | undefined {
  const [snapshot, setSnapshot] = useState<Snapshot>();

  useEffect(
    () =>
      session.events((event) => {
        const data = extensionData(event, snapshotKey);
        if (data !== undefined) {
          setSnapshot(snapshotOf(data));
        }
      }),
    [session],
  );

  return snapshot;
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!ticking) {
      return undefined;
    }

    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [ticking]);

  return now;
}

function RunCard({
  call,
  launch,
  session,
}: {
  readonly call: ToolCall;
  readonly launch: Launch;
  readonly session: MountedSession;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const asyncId = asyncIdOf(call.result?.details);
  const { run, finished } = useRun(session, asyncId);

  const state = finished?.status ?? run?.state ?? callState(call, asyncId);
  const tone = toneOf(state);
  const now = useNow(tone === "running");

  const started = run?.startedAt;

  const took =
    finished?.durationMs ??
    (started === undefined ? undefined : (run?.endedAt ?? now) - started);

  const tools = run ? toolCount(run) : 0;

  const facts = [
    stateLabel(state),
    ...(tools > 0
      ? [`${String(tools)} ${tools === 1 ? "tool" : "tools"}`]
      : []),
    ...(took === undefined ? [] : [elapsed(took)]),
  ];

  const model = run && modelOf(run);
  const tool = tone === "running" && run ? currentTool(run) : undefined;

  return (
    <div
      data-subagent-run={asyncId}
      data-subagent-tone={tone}
      className="overflow-hidden rounded-lg border border-line bg-panel"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className="flex w-full min-w-0 flex-col gap-0.5 px-3 py-2 text-left hover:bg-hover"
      >
        <span className="flex w-full min-w-0 items-center gap-2 text-label">
          <Mark tone={tone} />
          <span className="shrink-0 font-medium text-fg">{launch.agent}</span>
          <span className="min-w-0 flex-1 truncate text-fg-dim">
            {launch.task.split("\n")[0]}
          </span>
          <span className="shrink-0 text-fg-dim">{facts.join(" · ")}</span>
          <Icon
            name="chevron-right"
            className={cn(
              "size-3.5 shrink-0 text-fg-dim transition-transform",
              open && "rotate-90",
            )}
          />
        </span>
        {(model !== undefined || tool !== undefined) && (
          <span className="truncate pl-6 font-mono text-mono-sm text-fg-dim">
            {[model, tool === undefined ? undefined : `running ${tool}`]
              .filter((part) => part !== undefined)
              .join(" · ")}
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line px-3 py-2">
          {asyncId === undefined || !run ? (
            <Output text={call.result?.text ?? ""} failed={tone === "failed"} />
          ) : (
            steps(run).map((step) => (
              <StepDetail
                key={step.id}
                session={session}
                asyncId={asyncId}
                step={step}
                childId={step === run ? undefined : step.id}
                labelled={(run.children?.length ?? 0) > 1}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Before the snapshot or notice says, the call is all there is: a background
// run whose session has gone since shows as left in the background.
function callState(call: ToolCall, asyncId: string | undefined): string {
  if (call.status !== "done") {
    return call.status;
  }

  return asyncId === undefined ? "complete" : "detached";
}

function StepDetail({
  session,
  asyncId,
  step,
  childId,
  labelled,
}: {
  readonly session: MountedSession;
  readonly asyncId: string;
  readonly step: RunNode;
  readonly childId: string | undefined;
  readonly labelled: boolean;
}): ReactElement {
  const live = toneOf(step.state) === "running";
  const reply = useInspect(session, asyncId, childId, live);
  const transcript = reply && transcriptOf(reply);

  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      {labelled && (
        <h4 className="flex items-center gap-2 text-label font-medium text-fg">
          <Mark tone={toneOf(step.state)} />
          {step.agent ?? step.label}
        </h4>
      )}
      {!reply && <p className="text-label text-fg-dim">Loading…</p>}
      {reply?.error && (
        <p className="text-label text-fg-dim">{reply.error.message}</p>
      )}
      {transcript?.messages.map((message, at) => (
        <p
          key={at}
          className={cn(
            "min-w-0 font-mono text-mono-sm break-words whitespace-pre-wrap",
            message.kind === "text" ? "text-fg" : "text-fg-dim",
            message.isError === true && "text-failed",
          )}
        >
          {message.kind === "toolCall" && `› ${message.name ?? "tool"} `}
          {message.kind === "toolResult"
            ? firstLines(message.text)
            : message.text}
        </p>
      ))}
      {transcript?.output !== undefined && (
        <Output text={transcript.output} failed={step.state === "failed"} />
      )}
    </section>
  );
}

function firstLines(text: string): string {
  const lines = text.split("\n");

  return lines.length > 3 ? `${lines.slice(0, 3).join("\n")}\n…` : text;
}

// Asks pi-subagents for a step's task, messages and output when the card
// opens, and every two seconds while the step runs. Each viewer asks with its
// own request ids and reads only its own replies.
function useInspect(
  session: MountedSession,
  asyncId: string,
  childId: string | undefined,
  live: boolean,
): InspectReply | undefined {
  const [reply, setReply] = useState<InspectReply>();

  useEffect(() => {
    const asked = new Set<string>();

    const unsubscribe = session.events((event) => {
      const found = inspectReplyOf(extensionData(event, inspectKey));
      if (found && asked.has(found.requestId)) {
        setReply(found);
      }
    });

    const ask = (): void => {
      const requestId = crypto.randomUUID();
      asked.add(requestId);

      session.send(inspectCommand(requestId, asyncId, childId)).catch(() => {
        asked.delete(requestId);
      });
    };

    ask();

    const timer = live ? setInterval(ask, 2000) : undefined;

    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [session, asyncId, childId, live]);

  return reply;
}

function Output({
  text,
  failed,
}: {
  readonly text: string;
  readonly failed: boolean;
}): ReactElement | null {
  if (text === "") {
    return null;
  }

  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto rounded-md border border-line bg-code px-3 py-2 font-mono text-mono-sm whitespace-pre-wrap",
        failed ? "text-failed" : "text-fg",
      )}
    >
      {text}
    </pre>
  );
}

// A call that manages runs, such as status or stop, reads like a work step.
function ManageRow({ call }: { readonly call: ToolCall }): ReactElement {
  const { action } = call.args as { readonly action?: unknown };

  const tone: Tone = call.status;

  return (
    <details className="group/step">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-label hover:bg-hover [&::-webkit-details-marker]:hidden">
        <Mark tone={tone} />
        <span className="shrink-0 font-medium text-fg">Subagents</span>
        <span className="truncate font-mono text-mono-sm text-fg-dim">
          {typeof action === "string" ? action : ""}
        </span>
      </summary>
      <div className="mx-2 mt-1 mb-2">
        <Output text={call.result?.text ?? ""} failed={tone === "failed"} />
      </div>
    </details>
  );
}

function Mark({ tone }: { readonly tone: Tone }): ReactElement {
  switch (tone) {
    case "running":
      return (
        <span className="grid size-4 shrink-0 place-items-center">
          <span className="size-1.5 animate-pulse rounded-full bg-working" />
        </span>
      );
    case "done":
      return <Icon name="check" className="size-4 shrink-0 text-done" />;
    case "failed":
      return <Icon name="x" className="size-4 shrink-0 text-failed" />;
    case "stopped":
      return <Icon name="stop" className="size-4 shrink-0 text-fg-dim" />;
  }
}

// Drawn where pi-subagents puts its fleet summary while runs are active.
function RunningChip({ session }: WidgetProps): ReactElement | null {
  const count = runningCount(useSnapshot(session));

  if (count === 0) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => {
        document
          .querySelector('[data-subagent-tone="running"]')
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      }}
      className="inline-flex w-fit items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-label text-fg-dim hover:text-fg"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-working" />
      {count === 1
        ? "1 subagent running"
        : `${String(count)} subagents running`}
    </button>
  );
}
