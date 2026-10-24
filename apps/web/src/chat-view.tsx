import type { MountedSession } from "@pi-cloud/plugins/web";
import { cn, Icon } from "@pi-cloud/ui";
import {
  type ReactElement,
  type ReactNode,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { dataUrl } from "./attachments";
import {
  ago,
  describeTool,
  duration,
  linkParts,
  type Step,
  tally,
  type Turn,
  turns,
  type Work,
} from "./chat";
import type { Feed } from "./feed";
import { renderMarkdown } from "./markdown";
import { usePrimaryId } from "./primary";
import { PluginBoundary } from "./plugin-boundary";
import { pluginContext, toolRenderer } from "./plugins";
import { TerminalText } from "./terminal-text";

export function ChatView({
  feed,
  session,
  place,
  hidden,
}: {
  readonly feed: Feed;
  readonly session: MountedSession;
  readonly place: string;
  readonly hidden: boolean;
}): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const top = useRef(0);
  const shown = useMemo(() => turns(feed.items, claimed), [feed.items]);
  const chatId = usePrimaryId("chat");

  const live =
    feed.session?.status === "running" ||
    feed.streaming !== undefined ||
    feed.tools.length > 0;

  const now = useNow();

  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && !hidden) {
      // A hidden box loses its scroll position, so it is put back on showing.
      box.scrollTop = atBottom.current ? box.scrollHeight : top.current;
    }
  }, [feed.items, feed.streaming, feed.tools, feed.prompts, hidden]);

  // Widgets drawn around the composer shrink the chat after it has scrolled.
  useEffect(() => {
    const box = scroller.current;
    if (!box || hidden) {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (atBottom.current) {
        box.scrollTop = box.scrollHeight;
      }
    });

    observer.observe(box);

    return () => {
      observer.disconnect();
    };
  }, [hidden]);

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const box = event.currentTarget;

        atBottom.current =
          box.scrollHeight - box.scrollTop - box.clientHeight < 40;

        top.current = box.scrollTop;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      {feed.header !== undefined && (
        <header className="mx-auto max-w-chat px-4 pt-8">
          <TerminalText text={feed.header} />
        </header>
      )}
      {shown.length === 0 && !live && feed.session && (
        <Greeting place={place} />
      )}
      <ol
        id={chatId}
        className="mx-auto flex max-w-chat flex-col gap-5 px-4 pt-8 pb-10"
      >
        {shown.map((turn, index) => {
          const last = index === shown.length - 1;

          const running = last
            ? feed.tools.filter(({ name }) => !claimed(name))
            : [];

          return [
            index > 0 && turn.user !== undefined && (
              <li
                key={`${String(turn.key)}-rule`}
                aria-hidden
                className="border-t border-line"
              />
            ),
            turn.user !== undefined && (
              <li
                key={`${String(turn.key)}-user`}
                data-role="user"
                className="max-w-[85%] self-end rounded-xl rounded-br-sm bg-elevated px-4 py-2.5 text-prose whitespace-pre-wrap text-fg-strong shadow-card [content-visibility:auto]"
              >
                {turn.images && (
                  <span className="mb-2 flex flex-wrap justify-end gap-2">
                    {turn.images.map((image, at) => (
                      <img
                        key={`${String(at)}-${image.data.slice(-16)}`}
                        src={dataUrl(image)}
                        alt={`Image ${String(at + 1)} sent with this message`}
                        className="max-h-48 max-w-full rounded-md border border-line object-contain"
                      />
                    ))}
                  </span>
                )}
                {turn.user}
              </li>
            ),
            hasSteps(turn.work) || running.length > 0 ? (
              <li key={`${String(turn.key)}-work`} data-role="work">
                <WorkBlock turn={turn} running={running} live={last && live} />
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
            ...turn.cards.map((step) => (
              <li key={`${String(turn.key)}-card-${step.id}`} data-role="card">
                <ToolCard step={step} session={session} />
              </li>
            )),
            ...turn.answer.map((text, at) => (
              <li
                key={`${String(turn.key)}-answer-${String(at)}`}
                data-role="assistant"
                className="[content-visibility:auto]"
              >
                <Answer text={text} />
              </li>
            )),
            turn.answer.length > 0 && !(last && live) && (
              <AnswerMeta
                key={`${String(turn.key)}-meta`}
                turn={turn}
                now={now}
              />
            ),
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

function useNow(): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 30_000);

    return () => {
      clearInterval(timer);
    };
  }, []);

  return now;
}

function AnswerMeta({
  turn,
  now,
}: {
  readonly turn: Turn;
  readonly now: number;
}): ReactElement | null {
  if (turn.ended === undefined && turn.model === undefined) {
    return null;
  }

  return (
    <li
      data-role="answer-meta"
      className="-mt-2 flex gap-3 text-caption text-fg-dim"
    >
      {turn.ended !== undefined && (
        <time
          dateTime={turn.ended}
          title={new Date(turn.ended).toLocaleString()}
        >
          {ago(turn.ended, now)}
        </time>
      )}
      {turn.model !== undefined && <span>{turn.model}</span>}
    </li>
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

function Markdown({ text }: { readonly text: string }): ReactElement {
  return (
    <div
      className="prose"
      // Markdown output escapes raw HTML and unsafe links (markdown.ts).
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}

const Answer = memo(Markdown);

function WorkBlock({
  turn,
  running,
  live,
}: {
  readonly turn: Turn;
  readonly running: readonly { readonly id: string; readonly name: string }[];
  readonly live: boolean;
}): ReactElement {
  const { work, started, ended } = turn;

  const steps = work.flatMap((item) =>
    item.kind === "step" ? [item.step] : [],
  );

  const failed = steps.filter((step) => step.result?.failed === true).length;
  const runningIds = new Set(running.map(({ id }) => id));

  const extra = running.filter(
    ({ id }) => !steps.some((step) => step.id === id),
  );

  const did = tally([...steps, ...extra]);

  return (
    <details open={live} className="group/work">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-1 text-label text-fg-dim select-none hover:text-fg [&::-webkit-details-marker]:hidden">
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
          <span className="font-medium text-fg">
            {started !== undefined && ended !== undefined
              ? `Worked for ${duration(started, ended)}`
              : "Worked"}
          </span>
        )}
        {did.map((part) => (
          <span key={part}>· {part}</span>
        ))}
        {failed > 0 && <span className="text-failed">· {failed} failed</span>}
      </summary>
      <ol className="flex flex-col gap-px pt-1 pl-5">
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
      <span className="min-w-0 break-words">{linked(text)}</span>
    </p>
  );
}

function linked(text: string): ReactNode[] {
  return linkParts(text).map((part, at) =>
    part.link ? (
      <a
        key={at}
        href={part.text}
        target="_blank"
        rel="noreferrer"
        className="text-fg underline"
      >
        {part.text}
      </a>
    ) : (
      part.text
    ),
  );
}

const claimed = (tool: string): boolean => toolRenderer(tool) !== undefined;

// A tool call drawn by the plugin that claims its tool (ADR 0030).
function ToolCard({
  step,
  session,
}: {
  readonly step: Step;
  readonly session: MountedSession;
}): ReactElement | null {
  const renderer = toolRenderer(step.name);

  if (!renderer) {
    return null;
  }

  const { plugin, Component } = renderer;

  const status = step.result?.failed === true ? "failed" : "done";

  return (
    <PluginBoundary name={plugin}>
      <Component
        context={pluginContext(plugin)}
        session={session}
        call={{
          id: step.id,
          name: step.name,
          args: step.args,
          status: step.result ? status : "running",
          ...(step.result && {
            result: {
              text: step.result.text,
              details: step.result.details,
              failed: step.result.failed,
            },
          }),
        }}
      />
    </PluginBoundary>
  );
}
