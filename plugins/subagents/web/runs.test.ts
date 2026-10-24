import { expect, test } from "bun:test";
import {
  currentTool,
  elapsed,
  finishedRuns,
  followRun,
  inspectCommand,
  inspectReplyOf,
  launchOf,
  modelOf,
  type RunNode,
  runningCount,
  snapshotOf,
  stateLabel,
  toneOf,
  toolCount,
  transcriptOf,
} from "./runs";

const run = (children: RunNode[]): RunNode => ({
  id: "r1",
  kind: "workflow",
  label: "review",
  state: "running",
  children,
});

const step = (id: string, fields: Partial<RunNode>): RunNode => ({
  id,
  kind: "step",
  label: id,
  state: "running",
  ...fields,
});

test("tells a call that starts work from one that manages runs", () => {
  expect(launchOf({ agent: "worker", task: "say hi" })).toEqual({
    agent: "worker",
    task: "say hi",
  });

  expect(launchOf({ workflow: "review" })).toEqual({
    agent: "workflow",
    task: "",
  });

  expect(launchOf({ action: "status", id: "r1" })).toBeUndefined();
});

test("reads only the versions of pi-subagents' formats it knows", () => {
  const snapshot = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    runs: [],
  } as const;

  expect(snapshotOf(snapshot)).toEqual(snapshot);
  expect(snapshotOf({ ...snapshot, version: 2 })).toBeUndefined();
  expect(snapshotOf(null)).toBeUndefined();
  expect(inspectReplyOf(snapshot)).toBeUndefined();

  expect(
    inspectReplyOf({
      kind: "pi-subagents.inspect-reply",
      version: 1,
      requestId: "q1",
    }),
  ).toEqual({
    kind: "pi-subagents.inspect-reply",
    version: 1,
    requestId: "q1",
  });
});

test("reads finished runs from the completion notice in the transcript", () => {
  const notice = JSON.stringify({
    type: "custom_message",
    customType: "subagent-notify",
    content: "Background task failed: **worker**",
    display: true,
    details: {
      runs: [
        { agent: "worker", status: "failed", runId: "r1", durationMs: 88 },
      ],
    },
  });

  expect(finishedRuns(notice)).toEqual([
    { agent: "worker", status: "failed", runId: "r1", durationMs: 88 },
  ]);

  expect(
    finishedRuns(JSON.stringify({ type: "message", text: "subagent-notify" })),
  ).toEqual([]);

  expect(finishedRuns('{"broken": "subagent-notify"')).toEqual([]);
});

test("sums a run's steps", () => {
  const review = run([
    step("step:0", {
      agent: "reviewer",
      model: "openai/gpt-5",
      state: "complete",
      activity: { toolCount: 4 },
    }),
    step("step:1", {
      agent: "worker",
      model: "openai/gpt-5",
      activity: { toolCount: 2, currentTool: "bash" },
    }),
  ]);

  expect(toolCount(review)).toBe(6);
  expect(currentTool(review)).toBe("bash");
  expect(modelOf(review)).toBe("openai/gpt-5");

  expect(
    modelOf(run([step("a", { model: "x/1" }), step("b", { model: "y/2" })])),
  ).toBeUndefined();
});

test("counts the runs still going", () => {
  expect(
    runningCount({
      kind: "pi-subagents.async-status-snapshot",
      version: 1,
      runs: [
        { ...run([]), state: "queued" },
        { ...run([]), state: "running" },
        { ...run([]), state: "complete" },
        { ...run([]), state: "failed" },
      ],
    }),
  ).toBe(2);

  expect(runningCount(undefined)).toBe(0);
});

test("names the states of runs and notices alike", () => {
  expect(toneOf("complete")).toBe("done");
  expect(toneOf("completed")).toBe("done");
  expect(toneOf("rejected")).toBe("failed");
  expect(toneOf("paused")).toBe("stopped");
  expect(stateLabel("complete")).toBe("Done");
  expect(stateLabel("running")).toBe("Running");
});

test("formats durations and inspect commands", () => {
  expect(elapsed(4_400)).toBe("4s");
  expect(elapsed(185_000)).toBe("3m 05s");

  expect(inspectCommand("q1", "r1", undefined)).toBe(
    "/subagents-inspect-rpc q1 r1 --lines 40",
  );

  expect(inspectCommand("q1", "r1", "step:0")).toBe(
    "/subagents-inspect-rpc q1 r1 step:0 --lines 40",
  );
});

test("keeps a run's clock from its first start", () => {
  const queued = { ...run([]), state: "queued", startedAt: 1_000 };
  const running = { ...run([]), state: "running", startedAt: 4_000 };

  expect(followRun(undefined, queued).startedAt).toBe(1_000);
  expect(followRun(queued, running)).toEqual({ ...running, startedAt: 1_000 });
  expect(followRun(running, { ...run([]) }).startedAt).toBe(4_000);
});

test("shows a step's work without its prompt or a repeated output", () => {
  const reply = {
    kind: "pi-subagents.inspect-reply",
    version: 1,
    requestId: "q1",
    task: "List the files\n---\n**Output:** Write your findings to ...",
    messages: [
      { role: "user", kind: "text", text: "List the files\n**Output:** ..." },
      { role: "assistant", kind: "toolCall", text: "ls", name: "ls" },
      { role: "assistant", kind: "text", text: "Two files.\n" },
    ],
    finalOutput: "Two files.",
  } as const;

  expect(transcriptOf(reply)).toEqual({
    messages: [
      { role: "assistant", kind: "toolCall", text: "ls", name: "ls" },
      { role: "assistant", kind: "text", text: "Two files.\n" },
    ],
    output: undefined,
  });

  expect(
    transcriptOf({ ...reply, messages: [], finalOutput: "Report" }).output,
  ).toBe("Report");
});
