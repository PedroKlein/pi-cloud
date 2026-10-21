import { cn, Icon } from "@pi-cloud/ui";
import { type ReactElement, useLayoutEffect, useRef } from "react";
import { describeTool, type Step, turns, type Work } from "./chat";
import type { Feed } from "./feed";
import { renderMarkdown } from "./markdown";

export function ChatView({
  feed,
  place,
}: {
  readonly feed: Feed;
  readonly place: string;
}): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const shown = turns(feed.items);
  const live = feed.streaming !== undefined || feed.tools.length > 0;

  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && atBottom.current) {
      box.scrollTop = box.scrollHeight;
    }
  }, [feed.items, feed.streaming, feed.tools, feed.prompts]);

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const box = event.currentTarget;

        atBottom.current =
          box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      {shown.length === 0 && !live && feed.session && (
        <Greeting place={place} />
      )}
      <ol
        id="chat"
        className="mx-auto flex max-w-chat flex-col gap-5 px-4 pt-8 pb-10"
      >
        {shown.map((turn, index) => {
          const last = index === shown.length - 1;
          const running = last ? feed.tools : [];

          return [
            turn.user !== undefined && (
              <li
                key={`${String(turn.key)}-user`}
                data-role="user"
                className="max-w-[85%] self-end rounded-xl rounded-br-sm bg-elevated px-4 py-2.5 text-prose whitespace-pre-wrap text-fg-strong shadow-card [content-visibility:auto]"
              >
                {turn.user}
              </li>
            ),
            hasSteps(turn.work) || running.length > 0 ? (
              <li key={`${String(turn.key)}-work`} data-role="work">
                <WorkBlock
                  work={turn.work}
                  running={running}
                  live={last && live}
                />
              </li>
            ) : (
              turn.work.map((item, at) =>
                item.kind === "step" ? null : (
                  <li
                    key={`${String(turn.key)}-note-${String(at)}`}
                    data-role={item.kind}
                  >
                    <WorkNote kind={item.kind} text={item.text} />
                  </li>
                ),
              )
            ),
            ...turn.answer.map((text, at) => (
              <li
                key={`${String(turn.key)}-answer-${String(at)}`}
                data-role="assistant"
                className="[content-visibility:auto]"
              >
                <Answer text={text} />
              </li>
            )),
          ];
        })}
        {feed.streaming !== undefined && (
          <li data-role="assistant">
            <Answer text={feed.streaming} />
          </li>
        )}
      </ol>
    </div>
  );
}

function hasSteps(work: readonly Work[]): boolean {
  return work.some((item) => item.kind === "step");
}

function Greeting({ place }: { readonly place: string }): ReactElement {
  return (
    <div className="mx-auto flex max-w-chat flex-col items-center gap-3 px-4 pt-[18vh] text-center">
      <span className="grid size-10 place-items-center rounded-lg bg-accent-tint font-mono text-title text-accent">
        π
      </span>
      <p className="text-title font-semibold text-fg-strong">
        What should Pi do in {place}?
      </p>
      <p className="text-label text-fg-dim">
        Ask below. Pi works in the session&apos;s workspace and can run commands
        there.
      </p>
    </div>
  );
}

function Answer({ text }: { readonly text: string }): ReactElement {
  return (
    <div
      className="prose"
      // Markdown output escapes raw HTML and unsafe links (markdown.ts).
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}

function WorkBlock({
  work,
  running,
  live,
}: {
  readonly work: readonly Work[];
  readonly running: readonly { readonly id: string; readonly name: string }[];
  readonly live: boolean;
}): ReactElement {
  const steps = work.flatMap((item) =>
    item.kind === "step" ? [item.step] : [],
  );

  const failed = steps.filter((step) => step.result?.failed === true).length;
  const runningIds = new Set(running.map(({ id }) => id));

  const extra = running.filter(
    ({ id }) => !steps.some((step) => step.id === id),
  );

  return (
    <details
      open={live}
      className="group/work rounded-lg border border-line bg-panel open:pb-1"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-3 py-2 text-label text-fg-dim select-none hover:text-fg [&::-webkit-details-marker]:hidden">
        <Icon
          name="chevron-right"
          className="mr-0.5 size-3.5 transition-transform group-open/work:rotate-90"
        />
        {live ? (
          <span className="flex items-center gap-2 text-working">
            <span className="size-1.5 animate-pulse rounded-full bg-working" />
            Working
          </span>
        ) : (
          <span>Worked</span>
        )}
        <span>
          · {steps.length + extra.length}{" "}
          {steps.length + extra.length === 1 ? "step" : "steps"}
        </span>
        {failed > 0 && <span className="text-failed">· {failed} failed</span>}
      </summary>
      <ol className="flex flex-col gap-px px-1">
        {work.map((item, index) => (
          <li
            key={
              item.kind === "step"
                ? item.step.id
                : `${item.kind}-${String(index)}`
            }
          >
            {item.kind === "step" ? (
              <StepRow
                step={item.step}
                running={runningIds.has(item.step.id)}
              />
            ) : (
              <WorkNote kind={item.kind} text={item.text} />
            )}
          </li>
        ))}
        {extra.map(({ id, name }) => (
          <li key={id}>
            <StepRow step={{ id, name, args: undefined }} running />
          </li>
        ))}
      </ol>
    </details>
  );
}

function StepRow({
  step,
  running,
}: {
  readonly step: Step;
  readonly running: boolean;
}): ReactElement {
  const { verb, object } = describeTool(step.name, step.args);

  const line = (
    <>
      <StepMark running={running} failed={step.result?.failed === true} />
      <span className="shrink-0 font-medium text-fg">{verb}</span>
      <span className="truncate font-mono text-mono-sm text-fg-dim">
        {object}
      </span>
    </>
  );

  const row = "flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-label";

  if (!step.result || step.result.text === "") {
    return <div className={row}>{line}</div>;
  }

  return (
    <details className="group/step">
      <summary
        className={cn(
          row,
          "cursor-pointer list-none hover:bg-hover [&::-webkit-details-marker]:hidden",
        )}
      >
        {line}
      </summary>
      <pre
        className={cn(
          "mx-2 mt-1 mb-2 max-h-80 overflow-auto rounded-md border border-line bg-code px-3 py-2 font-mono text-mono-sm whitespace-pre-wrap",
          step.result.failed ? "text-failed" : "text-fg",
        )}
      >
        {step.result.text}
      </pre>
    </details>
  );
}

function StepMark({
  running,
  failed,
}: {
  readonly running: boolean;
  readonly failed: boolean;
}): ReactElement {
  if (running) {
    return (
      <span className="grid size-4 shrink-0 place-items-center">
        <span className="size-1.5 animate-pulse rounded-full bg-working" />
      </span>
    );
  }

  return failed ? (
    <Icon name="x" className="size-4 shrink-0 text-failed" />
  ) : (
    <Icon name="check" className="size-4 shrink-0 text-done" />
  );
}

function WorkNote({
  kind,
  text,
}: {
  readonly kind: "narration" | "error" | "note";
  readonly text: string;
}): ReactElement {
  return (
    <p
      className={cn(
        "flex gap-2 px-2 py-1 text-label whitespace-pre-wrap",
        kind === "error" ? "text-failed" : "text-fg-dim",
      )}
    >
      {kind === "note" && (
        <Icon name="info" className="mt-0.5 size-4 shrink-0" />
      )}
      {text}
    </p>
  );
}
