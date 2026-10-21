import {
  type ImageAttachment,
  imageLimits,
  imageTypes,
} from "@pi-cloud/protocol";
import { Button, Icon } from "@pi-cloud/ui";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { command } from "./api";
import { admit, dataUrl } from "./attachments";
import type { Feed } from "./feed";
import { PromptCard, type PromptHandlers } from "./prompt-card";
import { useSuggestions } from "./suggestions";

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
  const [images, setImages] = useState<readonly Attached[]>([]);
  const suggestions = useSuggestions(feed);
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

  const attach = (files: readonly File[]): void => {
    const { admitted, problems } = admit(images.length, files);

    if (problems.length > 0) {
      report(problems.join(" "));
    }

    void Promise.all(admitted.map(attached)).then((read) => {
      setImages((current) => [...current, ...read].slice(0, imageLimits.count));
    }, report);
  };

  const send = (delivery: "steer" | "followUp"): void => {
    const box = text.current;
    const message = box?.value.trim() ?? "";
    if (!box || (message === "" && images.length === 0)) {
      return;
    }

    box.value = "";
    setImages([]);

    command(sessionId, {
      type: "message",
      text: message,
      ...(images.length > 0 && {
        images: images.map(({ mimeType, data }) => ({ mimeType, data })),
      }),
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
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
            }
          }}
          onDrop={(event) => {
            if (event.dataTransfer.files.length > 0) {
              event.preventDefault();
              attach([...event.dataTransfer.files]);
            }
          }}
          className="relative flex flex-col gap-2 rounded-xl border border-line bg-elevated py-2 pr-2 pl-4 shadow-card focus-within:border-accent"
        >
          {suggestions.menu}
          <label htmlFor="prompt-text" className="sr-only">
            Message Pi
          </label>
          {images.length > 0 && (
            <ul
              aria-label="Attached images"
              className="flex flex-wrap gap-2 pt-1"
            >
              {images.map((image) => (
                <li key={image.id} className="relative">
                  <img
                    src={dataUrl(image)}
                    alt={image.name}
                    className="size-16 rounded-md border border-line object-cover"
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${image.name}`}
                    onClick={() => {
                      setImages((current) =>
                        current.filter(({ id }) => id !== image.id),
                      );
                    }}
                    className="absolute -top-1.5 -right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full border border-line bg-panel text-fg-dim hover:text-fg"
                  >
                    <Icon name="x" className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={text}
            id="prompt-text"
            name="text"
            rows={2}
            placeholder="Message Pi"
            {...suggestions.box}
            onPaste={(event) => {
              const pasted = [...event.clipboardData.files];
              if (pasted.length > 0) {
                event.preventDefault();
                attach(pasted);
              }
            }}
            onKeyDown={(event) => {
              if (suggestions.keyDown(event)) {
                return;
              }

              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send(event.altKey ? "followUp" : "steer");
              }
            }}
            className="resize-none bg-transparent pt-1 text-prose text-fg placeholder:text-fg-dim focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <label
              title="Attach images"
              className="-ml-2 flex size-8 cursor-pointer items-center justify-center rounded-full text-fg-dim hover:bg-hover hover:text-fg has-focus-visible:outline-2 has-focus-visible:outline-accent"
            >
              <Icon name="paperclip" />
              <input
                type="file"
                multiple
                accept={imageTypes.join(",")}
                aria-label="Attach images"
                onChange={(event) => {
                  attach([...(event.target.files ?? [])]);
                  event.target.value = "";
                }}
                className="sr-only"
              />
            </label>
            <span className="flex-1 text-caption text-fg-dim max-sm:hidden">
              Enter steers · Alt+Enter queues a follow-up · / for commands
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

interface Attached extends ImageAttachment {
  readonly id: string;
  readonly name: string;
}

async function attached(file: File): Promise<Attached> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    });

    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error(`couldn't read ${file.name}`));
    });

    reader.readAsDataURL(file);
  });

  return {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type as ImageAttachment["mimeType"],
    data: url.slice(url.indexOf(",") + 1),
  };
}

function Widget({ text }: { readonly text: string }): ReactElement {
  return (
    <pre className="rounded-md bg-code px-3 py-2 font-mono text-mono-sm whitespace-pre-wrap text-fg-dim">
      {text}
    </pre>
  );
}
