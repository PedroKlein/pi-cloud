import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import type { AskPermission, AskQuestions, Explain } from "@pipoca/plugins";
import type { Answer, Command, LiveEvent, Prompt } from "@pipoca/protocol";

export type RemoteUI = Pick<
  ExtensionUIContext,
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify"
  | "setTitle"
  | "setEditorText"
  | "custom"
>;

type PromptRequest = Prompt extends infer P
  ? P extends Prompt
    ? Omit<P, "id">
    : never
  : never;

export function remoteUI(publish: (event: LiveEvent) => void): {
  readonly ui: RemoteUI;
  readonly questions: AskQuestions;
  readonly permission: AskPermission;
  readonly secret: (
    title: string,
    placeholder: string | undefined,
    signal: AbortSignal | undefined,
  ) => Promise<string | undefined>;
  readonly answer: (id: string, value: Answer) => void;
  readonly explain: (command: Extract<Command, { type: "explain" }>) => void;
  readonly cancelAll: () => void;
} {
  const openPrompts = new Map<
    string,
    {
      readonly done: (value: Answer) => void;
      readonly explain: Explain | undefined;
    }
  >();

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
        openPrompts.delete(id);
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
      openPrompts.set(id, { done, explain });

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
        publish({
          type: "notify",
          message: stripVTControlCharacters(message),
          level: level ?? "info",
        });
      },
      setTitle: (title) => {
        publish({ type: "title", title });
      },
      setEditorText: (value) => {
        publish({ type: "editor_text", text: value });
      },
      // A custom dialog is a terminal component, which the web can't draw.
      custom: async () =>
        Promise.reject(
          new Error("Pipoca's web UI can't show custom terminal dialogs"),
        ),
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
    permission: async (title, details, signal) => {
      const value = await ask(
        { kind: "permission", title, details },
        signal ? { signal } : undefined,
      );

      return value === "once" || value === "session" ? value : "deny";
    },
    secret: async (title, placeholder, signal) =>
      text(
        await ask(
          { kind: "secret", title, placeholder: placeholder ?? null },
          signal ? { signal } : undefined,
        ),
      ),
    answer: (id, value) => {
      openPrompts.get(id)?.done(value);
    },
    explain: ({ id, questionId, value, question }) => {
      const explainer = openPrompts.get(id)?.explain;
      if (!explainer) {
        return;
      }

      const reply = (
        result: { text: string; error: null } | { text: null; error: string },
      ): void => {
        if (openPrompts.has(id)) {
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
      for (const { done } of [...openPrompts.values()]) {
        done(null);
      }
    },
  };
}
