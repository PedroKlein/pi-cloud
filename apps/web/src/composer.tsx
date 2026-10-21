import { Button, Icon } from "@pi-cloud/ui";
import { type ReactElement, useEffect, useRef } from "react";
import { command } from "./api";
import type { Feed } from "./feed";
import { PromptCard, type PromptHandlers } from "./prompt-card";

export function Composer({
  sessionId,
  feed,
  hidden,
  report,
}: {
  readonly sessionId: string;
  readonly feed: Feed;
  readonly hidden: boolean;
  readonly report: (error: unknown) => void;
}): ReactElement {
  const text = useRef<HTMLTextAreaElement>(null);
  const running = feed.session?.status === "running";
  const { steering, followUp } = feed.queue;

  useEffect(() => {
    if (feed.editorText && text.current) {
      text.current.value = feed.editorText.text;
      text.current.focus();
    }
  }, [feed.editorText]);

  const handlers: PromptHandlers = {
    answer: (id, value) => {
      command(sessionId, { type: "answer", id, value }).catch(report);
    },
    explain: (id, questionId, value, question) => {
      command(sessionId, {
        type: "explain",
        id,
        questionId,
        value,
        question,
      }).catch(report);
    },
  };

  const send = (delivery: "steer" | "followUp"): void => {
    const box = text.current;
    const message = box?.value.trim() ?? "";
    if (!box || message === "") {
      return;
    }

    box.value = "";

    command(sessionId, {
      type: "message",
      text: message,
      requestId: crypto.randomUUID(),
      delivery,
    }).catch(report);
  };

  return (
    <div className="mx-auto flex w-full max-w-chat flex-col gap-2 px-4 pb-4">
      {feed.prompts.map((open) => (
        <PromptCard key={open.prompt.id} open={open} handlers={handlers} />
      ))}

      {[
        ...steering.map((t) => ["Steering", t]),
        ...followUp.map((t) => ["Follow-up", t]),
      ].map(([kind, queued], index) => (
        <p
          key={`${String(index)}-${String(queued)}`}
          className="max-w-[80%] self-end rounded-lg border border-dashed border-line-strong bg-elevated px-3 py-1 text-ui text-fg-dim"
        >
          <span className="mr-2 text-caption font-medium">{kind}</span>
          {queued}
        </p>
      ))}

      {feed.widgetsAbove !== "" && <Widget text={feed.widgetsAbove} />}

      {!hidden && (
        <form
          id="prompt"
          onSubmit={(event) => {
            event.preventDefault();
            send("steer");
          }}
          className="flex flex-col gap-2 rounded-xl border border-line bg-elevated py-2 pr-2 pl-4 shadow-card focus-within:border-accent"
        >
          <label htmlFor="prompt-text" className="sr-only">
            Message Pi
          </label>
          <textarea
            ref={text}
            id="prompt-text"
            name="text"
            rows={2}
            placeholder="Message Pi"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send(event.altKey ? "followUp" : "steer");
              }
            }}
            className="resize-none bg-transparent pt-1 text-prose text-fg placeholder:text-fg-dim focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <span className="flex-1 text-caption text-fg-dim max-sm:hidden">
              Enter steers · Alt+Enter queues a follow-up
            </span>
            {running && (
              <Button
                variant="default"
                iconOnly
                aria-label="Stop"
                className="rounded-full"
                onClick={() => {
                  command(sessionId, { type: "abort" }).catch(report);
                }}
              >
                <Icon name="stop" />
              </Button>
            )}
            <Button
              variant="primary"
              iconOnly
              type="submit"
              aria-label="Send"
              className="ml-auto rounded-full"
            >
              <Icon name="arrow-up" />
            </Button>
          </div>
        </form>
      )}

      {feed.widgetsBelow !== "" && <Widget text={feed.widgetsBelow} />}

      {feed.statuses.length > 0 && (
        <footer className="px-2 text-caption text-fg-dim">
          {feed.statuses.join(" · ")}
        </footer>
      )}
    </div>
  );
}

function Widget({ text }: { readonly text: string }): ReactElement {
  return (
    <pre className="rounded-md bg-code px-3 py-2 font-mono text-code-sm whitespace-pre-wrap text-fg-dim">
      {text}
    </pre>
  );
}
