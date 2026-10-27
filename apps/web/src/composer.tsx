import {
  type ImageAttachment,
  imageLimits,
  imageTypes,
  type ModelRef,
} from "@pipoca/protocol";
import type { MountedSession } from "@pipoca/plugins/web";
import { Button, cn, Icon, isComposing, Picker } from "@pipoca/ui";
import {
  type ReactElement,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { command } from "./api";
import { admit, dataUrl } from "./attachments";
import type { Feed, Settings, ShownWidget } from "./feed";
import { modelName, modelRef } from "./names";
import { usePrimaryId } from "./primary";
import { PluginBoundary } from "./plugin-boundary";
import { pluginContext, widgetRenderer } from "./plugins";
import { PromptCard, type PromptHandlers } from "./prompt-card";
import { browserCommand } from "./suggest";
import { useSuggestions } from "./suggestions";
import { Styled, TerminalColumns, TerminalText } from "./terminal-text";

// Pi reads a message sent now after its current step, and a queued one when
// it finishes.
const sendNowKeys = /Mac|iPhone|iPad/.test(navigator.userAgent)
  ? "⌘Enter"
  : "Ctrl+Enter";

export function Composer({
  sessionId,
  session,
  feed,
  models,
  hidden,
  report,
}: {
  readonly sessionId: string;
  readonly session: MountedSession;
  readonly feed: Feed;
  readonly models: readonly ModelRef[];
  readonly hidden: boolean;
  readonly report: (error: unknown) => void;
}): ReactElement {
  const text = useRef<HTMLTextAreaElement>(null);
  const promptId = usePrimaryId("prompt");
  const generatedId = useId();
  const textId = usePrimaryId("prompt-text") ?? generatedId;
  const modelMenu = useRef<HTMLButtonElement>(null);
  const [images, setImages] = useState<readonly Attached[]>([]);
  const suggestions = useSuggestions(feed);
  const running = feed.session?.status === "running";
  const { steering, followUp } = feed.queue;
  const [columns, setColumns] = useState<number>();
  const generation = feed.session?.generation;
  const hosted = feed.session?.status === "idle" || running;

  useEffect(() => {
    if (columns === undefined || !hosted) {
      return;
    }

    const later = setTimeout(() => {
      // Only a running Session can hear it, and each start is told again.
      command(sessionId, { type: "ui_columns", columns }).catch(
        () => undefined,
      );
    }, 200);

    return () => {
      clearTimeout(later);
    };
  }, [sessionId, columns, generation, hosted]);

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

    modelMenu.current?.click();
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
    }).catch((error: unknown) => {
      box.value = box.value === "" ? message : `${message}\n${box.value}`;

      setImages((current) =>
        [...images, ...current].slice(0, imageLimits.count),
      );

      report(error);
    });
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

      <TerminalColumns onColumns={setColumns} />

      <Widgets widgets={feed.widgetsAbove} session={session} />

      {!hidden && (
        <form
          id={promptId}
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
          className="relative flex flex-col gap-2 rounded-xl border border-line bg-elevated py-2 pr-2 pl-4 shadow-card transition-[border-color,box-shadow] duration-150 focus-within:border-line-focus focus-within:ring-4 focus-within:ring-focus"
        >
          {suggestions.menu}
          <label htmlFor={textId} className="sr-only">
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
            id={textId}
            name="text"
            rows={2}
            placeholder="Message Pi"
            {...suggestions.box}
            onPaste={(event) => {
              const pasted = [...event.clipboardData.files];

              // Excel and Word put a picture of the copied cells or text next
              // to the text itself, as HTML. A copied file has no HTML.
              if (
                pasted.length > 0 &&
                !event.clipboardData.types.includes("text/html")
              ) {
                event.preventDefault();
                attach(pasted);
              }
            }}
            onKeyDown={(event) => {
              if (isComposing(event) || suggestions.keyDown(event)) {
                return;
              }

              const steer = event.metaKey || event.ctrlKey;

              // On a phone Enter is the only way to start a new line, so the
              // Send button sends, as in Claude Code on the web.
              if (
                event.key !== "Enter" ||
                event.shiftKey ||
                (!steer && matchMedia("(pointer: coarse)").matches)
              ) {
                return;
              }

              event.preventDefault();
              send(steer ? "steer" : "followUp");
            }}
            className="max-h-72 min-h-12 resize-none field-sizing-content bg-transparent pt-1 text-prose text-fg placeholder:text-fg-dim focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <label
              title="Attach images"
              className="-ml-2 flex size-8 cursor-pointer items-center justify-center rounded-full text-fg-dim hover:bg-hover hover:text-fg has-focus-visible:outline-2 has-focus-visible:outline-line-focus"
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
              <ModelMenu
                settings={feed.settings}
                models={models}
                modelMenu={modelMenu}
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

      <Widgets widgets={feed.widgetsBelow} session={session} />

      {feed.footer === undefined ? (
        feed.statuses.length > 0 && (
          <footer className="px-2 text-caption text-fg-dim">
            <Styled text={feed.statuses.join(" · ")} />
          </footer>
        )
      ) : (
        <footer>
          <TerminalText text={feed.footer} className="text-fg-dim" />
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

// Extensions' widgets as Pi's TUI draws them, one box for each run of
// widgets no plugin claims (ADR 0030).
function Widgets({
  widgets,
  session,
}: {
  readonly widgets: readonly ShownWidget[];
  readonly session: MountedSession;
}): ReactElement[] {
  const shown: ReactElement[] = [];
  let lines: string[] = [];

  const box = (): void => {
    if (lines.length > 0) {
      shown.push(
        <TerminalText
          key={`text-${String(shown.length)}`}
          text={lines.join("\n")}
          className="rounded-md bg-code py-2"
        />,
      );

      lines = [];
    }
  };

  for (const widget of widgets) {
    const renderer = widgetRenderer(widget.key);

    if (!renderer) {
      lines.push(...widget.lines);

      continue;
    }

    box();

    const { plugin, Component } = renderer;

    shown.push(
      <PluginBoundary key={widget.key} name={plugin}>
        <Component
          context={pluginContext(plugin)}
          session={session}
          lines={widget.lines}
        />
      </PluginBoundary>,
    );
  }

  box();

  return shown;
}

// Claude Code's model menu with its effort levels, on Pi's model and reasoning level
// (ADR 0023).
function ModelMenu({
  settings,
  models,
  modelMenu,
  onModel,
  onLogin,
  onThinking,
}: {
  readonly settings: Settings;
  readonly models: readonly ModelRef[];
  readonly modelMenu: RefObject<HTMLButtonElement | null>;
  readonly onModel: (model: ModelRef) => void;
  readonly onLogin: () => void;
  readonly onThinking: (level: Settings["thinking"]) => void;
}): ReactElement {
  const current = settings.model ? modelName(settings.model) : "";

  const known = [
    ...new Map(
      [settings.model, ...models, ...settings.models].flatMap((model) =>
        model ? [[modelName(model), model] as const] : [],
      ),
    ).values(),
  ];

  return (
    <Picker
      label="Model"
      quiet
      trigger={modelMenu}
      options={known.map((model) => ({
        value: modelName(model),
        label: model.id,
        group: model.provider,
      }))}
      selected={[current]}
      {...(known.length > 6 && { placeholder: "Search models" })}
      actions={[{ label: "Log in to a provider…", run: onLogin }]}
      {...(settings.levels.length > 1 && {
        footer: (
          <div
            role="radiogroup"
            aria-label="Reasoning"
            className="flex flex-wrap items-center gap-1"
          >
            <span className="mr-1">Reasoning</span>
            {settings.levels.map((level) => (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={settings.thinking === level}
                onClick={() => {
                  onThinking(level);
                }}
                className={cn(
                  "cursor-pointer rounded-md px-1.5 py-0.5 hover:bg-hover",
                  settings.thinking === level &&
                    "bg-accent-tint text-fg-strong",
                )}
              >
                {level}
              </button>
            ))}
          </div>
        ),
      })}
      onChange={([name]) => {
        const model = modelRef(name ?? "");

        if (model) {
          onModel(model);
        }
      }}
    >
      {settings.model?.id ?? "Choose a model"}
      {settings.levels.length > 1 &&
        settings.thinking !== "off" &&
        ` · ${settings.thinking}`}
    </Picker>
  );
}
