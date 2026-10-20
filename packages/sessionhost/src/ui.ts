import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
} from "@earendil-works/pi-coding-agent";
import type {
  Answer,
  Command,
  LiveEvent,
  Prompt,
  Question,
  QuestionsAnswer,
} from "@pi-cloud/protocol";

export type RemoteUI = Pick<
  ExtensionUIContext,
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify"
  | "setStatus"
  | "setWidget"
  | "setTitle"
  | "setEditorText"
>;

type PromptRequest = Prompt extends infer P
  ? P extends Prompt
    ? Omit<P, "id">
    : never
  : never;

export type Explain = (
  questionId: string,
  value: string,
  question: string | null,
) => Promise<string>;

export type AskQuestions = (
  questions: readonly Question[],
  explain: Explain | undefined,
  signal: AbortSignal | undefined,
) => Promise<QuestionsAnswer | null>;

export function remoteUI(publish: (event: LiveEvent) => void): {
  readonly ui: RemoteUI;
  readonly questions: AskQuestions;
  readonly answer: (id: string, value: Answer) => void;
  readonly explain: (command: Extract<Command, { type: "explain" }>) => void;
  readonly cancelAll: () => void;
} {
  const pending = new Map<string, (value: Answer) => void>();
  const explainers = new Map<string, Explain>();

  const ask = async (
    request: PromptRequest,
    options: ExtensionUIDialogOptions | undefined,
    explain?: Explain,
  ): Promise<Answer> => {
    if (options?.signal?.aborted === true) {
      return null;
    }

    const id = randomUUID();

    return new Promise((resolve) => {
      const done = (value: Answer): void => {
        pending.delete(id);
        explainers.delete(id);
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", cancel);
        publish({ type: "prompt_end", id });
        resolve(value);
      };

      const cancel = (): void => {
        done(null);
      };

      const timer =
        options?.timeout === undefined
          ? undefined
          : setTimeout(cancel, options.timeout);

      options?.signal?.addEventListener("abort", cancel);
      pending.set(id, done);
      if (explain) {
        explainers.set(id, explain);
      }

      publish({ type: "prompt", prompt: { id, ...request } as Prompt });
    });
  };

  const text = (value: Answer): string | undefined =>
    typeof value === "string" ? value : undefined;

  return {
    ui: {
      select: async (title, options, opts) =>
        text(await ask({ kind: "select", title, options }, opts)),
      confirm: async (title, message, opts) =>
        (await ask({ kind: "confirm", title, message }, opts)) === true,
      input: async (title, placeholder, opts) =>
        text(
          await ask(
            { kind: "input", title, placeholder: placeholder ?? null },
            opts,
          ),
        ),
      editor: async (title, prefill) =>
        text(
          await ask(
            { kind: "editor", title, prefill: prefill ?? null },
            undefined,
          ),
        ),
      notify: (message, level) => {
        publish({ type: "notify", message, level: level ?? "info" });
      },
      setStatus: (key, value) => {
        publish({
          type: "extension_status",
          key,
          text: value === undefined ? null : stripVTControlCharacters(value),
        });
      },
      setWidget: (
        key: string,
        content:
          readonly string[] | ((...args: never[]) => unknown) | undefined,
        options?: ExtensionWidgetOptions,
      ) => {
        if (typeof content === "function") {
          return;
        }

        publish({
          type: "widget",
          key,
          lines: content?.map((line) => stripVTControlCharacters(line)) ?? null,
          placement: options?.placement ?? "aboveEditor",
        });
      },
      setTitle: (title) => {
        publish({ type: "title", title });
      },
      setEditorText: (value) => {
        publish({ type: "editor_text", text: value });
      },
    },
    questions: async (questions, explain, signal) => {
      const value = await ask(
        {
          kind: "questions",
          title: "Questions from the agent",
          questions,
          explain: explain !== undefined,
        },
        signal ? { signal } : undefined,
        explain,
      );

      return typeof value === "object" ? value : null;
    },
    answer: (id, value) => {
      pending.get(id)?.(value);
    },
    explain: ({ id, questionId, value, question }) => {
      const explainer = explainers.get(id);
      if (!explainer) {
        return;
      }

      const reply = (
        result: { text: string; error: null } | { text: null; error: string },
      ): void => {
        if (explainers.has(id)) {
          publish({
            type: "explanation",
            id,
            questionId,
            value,
            question,
            ...result,
          });
        }
      };

      explainer(questionId, value, question).then(
        (answer) => {
          reply({ text: answer, error: null });
        },
        (error: unknown) => {
          reply({ text: null, error: String(error) });
        },
      );
    },
    cancelAll: () => {
      for (const done of [...pending.values()]) {
        done(null);
      }
    },
  };
}
