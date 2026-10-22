import {
  type ImageAttachment,
  imageLimits,
  imageTypes,
  type ModelRef,
} from "@pi-cloud/protocol";
import { Button, Icon } from "@pi-cloud/ui";
import {
  type ReactElement,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { command } from "./api";
import { admit, dataUrl } from "./attachments";
import type { Feed, Settings } from "./feed";
import { modelName, modelRef } from "./names";
import { PromptCard, type PromptHandlers } from "./prompt-card";
import { browserCommand } from "./suggest";
import { useSuggestions } from "./suggestions";

// Pi reads a message sent now after its current step, and a queued one when
// it finishes.
const sendNowKeys = /Mac|iPhone|iPad/.test(navigator.userAgent)
  ? "⌘Enter"
  : "Ctrl+Enter";

export function Composer({
  sessionId,
  feed,
  models,
  hidden,
  report,
}: {
  readonly sessionId: string;
  readonly feed: Feed;
  readonly models: readonly ModelRef[];
  readonly hidden: boolean;
  readonly report: (error: unknown) => void;
}): ReactElement {
  const text = useRef<HTMLTextAreaElement>(null);
  const modelMenu = useRef<HTMLSelectElement>(null);
  const reasoningMenu = useRef<HTMLSelectElement>(null);
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

  const runInBrowser = (name: "copy" | "model" | "thinking"): void => {
    if (name === "copy") {
      const answer = feed.items
        .flatMap((item) => (item.role === "assistant" ? [item.text] : []))
        .at(-1);

      navigator.clipboard.writeText(answer ?? "").catch(report);

      return;
    }

    const menu = (name === "model" ? modelMenu : reasoningMenu).current;
    menu?.focus();

    try {
      menu?.showPicker();
    } catch {
      // Focus is enough where a browser can't open a select's picker.
    }
  };

  const send = (delivery: "steer" | "followUp"): void => {
    const box = text.current;
    const message = box?.value.trim() ?? "";
    if (!box || (message === "" && images.length === 0)) {
      return;
    }

    const local = images.length === 0 ? browserCommand(message) : undefined;
    if (local) {
      box.value = "";
      runInBrowser(local);

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
        ...steering.map((t) => ["steer", t] as const),
        ...followUp.map((t) => ["followUp", t] as const),
      ].map(([delivery, queued], index) => (
        <p
          key={`${String(index)}-${queued}`}
          className="flex max-w-[80%] items-start gap-2 self-end rounded-lg border border-dashed border-line-strong bg-elevated py-1 pr-1 pl-3 text-ui text-fg-dim"
        >
          <span>
            <span className="mr-2 text-caption font-medium">
              {delivery === "steer" ? "Steering" : "Queued"}
            </span>
            {queued}
          </span>
          {delivery === "followUp" && (
            <button
              type="button"
              aria-label={`Send "${queued}" now`}
              title="Send now"
              onClick={() => {
                command(sessionId, {
                  type: "unqueue",
                  delivery,
                  text: queued,
                  sendNow: true,
                }).catch(report);
              }}
              className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-caption hover:bg-hover hover:text-fg"
            >
              <Icon name="arrow-up" className="size-3.5" />
              Send now
            </button>
          )}
          <button
            type="button"
            aria-label={`Take back "${queued}"`}
            title="Take back"
            onClick={() => {
              command(sessionId, {
                type: "unqueue",
                delivery,
                text: queued,
              }).catch(report);
            }}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-hover hover:text-fg"
          >
            <Icon name="x" className="size-3.5" />
          </button>
        </p>
      ))}

      {feed.widgetsAbove !== "" && <Widget text={feed.widgetsAbove} />}

      {!hidden && (
        <form
          id="prompt"
          onSubmit={(event) => {
            event.preventDefault();
            send("followUp");
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
                send(event.metaKey || event.ctrlKey ? "steer" : "followUp");
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
            {feed.settings && (
              <SettingsPickers
                settings={feed.settings}
                models={models}
                modelMenu={modelMenu}
                reasoningMenu={reasoningMenu}
                onModel={(model) => {
                  command(sessionId, { type: "set_model", model }).catch(
                    report,
                  );
                }}
                onLogin={() => {
                  command(sessionId, {
                    type: "message",
                    text: "/login",
                    requestId: crypto.randomUUID(),
                    delivery: "followUp",
                  }).catch(report);
                }}
                onThinking={(level) => {
                  command(sessionId, { type: "set_thinking", level }).catch(
                    report,
                  );
                }}
              />
            )}
            <span className="flex-1 truncate text-caption text-fg-dim max-md:hidden">
              {running
                ? `Enter queues · ${sendNowKeys} sends now`
                : "Enter sends"}{" "}
              · / commands · @ files
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

const picker =
  "h-7 max-w-48 field-sizing-content cursor-pointer truncate rounded-md bg-transparent px-1.5 text-caption text-fg-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent";

// Claude Code's model and effort menus, on Pi's model and reasoning level
// (ADR 0023).
const login = "login";

function SettingsPickers({
  settings,
  models,
  modelMenu,
  reasoningMenu,
  onModel,
  onLogin,
  onThinking,
}: {
  readonly settings: Settings;
  readonly models: readonly ModelRef[];
  readonly modelMenu: RefObject<HTMLSelectElement | null>;
  readonly reasoningMenu: RefObject<HTMLSelectElement | null>;
  readonly onModel: (model: ModelRef) => void;
  readonly onLogin: () => void;
  readonly onThinking: (level: Settings["thinking"]) => void;
}): ReactElement {
  const current = settings.model ? modelName(settings.model) : "";

  const names = [
    ...new Set([
      current,
      ...models.map(modelName),
      ...settings.models.map(modelName),
    ]),
  ].filter((name) => name !== "");

  return (
    <>
      <select
        ref={modelMenu}
        aria-label="Model"
        value={current}
        onChange={(event) => {
          if (event.target.value === login) {
            onLogin();

            return;
          }

          const model = modelRef(event.target.value);
          if (model) {
            onModel(model);
          }
        }}
        className={picker}
      >
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        <option value={login}>Log in to a provider…</option>
      </select>
      {settings.levels.length > 1 && (
        <select
          ref={reasoningMenu}
          aria-label="Reasoning"
          value={settings.thinking}
          onChange={(event) => {
            const level = settings.levels.find(
              (known) => known === event.target.value,
            );

            if (level) {
              onThinking(level);
            }
          }}
          className={picker}
        >
          {settings.levels.map((level) => (
            <option key={level} value={level}>
              {level === "off" ? "No reasoning" : `Reasoning: ${level}`}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
