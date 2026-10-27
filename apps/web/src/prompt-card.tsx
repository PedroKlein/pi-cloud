import type { Answer, Prompt } from "@pipoca/protocol";
import { Button, fieldClass } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import type { OpenPrompt } from "./feed";
import { Actions } from "./fields";
import { QuestionsForm } from "./questions-form";

export interface PromptHandlers {
  readonly answer: (id: string, value: Answer) => void;
  readonly explain: (
    id: string,
    questionId: string,
    value: string,
    question: string | null,
  ) => void;
}

export function PromptCard({
  open,
  handlers,
}: {
  readonly open: OpenPrompt;
  readonly handlers: PromptHandlers;
}): ReactElement {
  const { prompt } = open;

  const answer = (value: Answer): void => {
    handlers.answer(prompt.id, value);
  };

  return (
    <section
      data-role="prompt"
      aria-label={prompt.title}
      className="flex flex-col gap-3 rounded-xl border border-line-strong border-t-3 border-t-waiting bg-elevated p-4 shadow-card"
    >
      <strong className="text-label font-semibold text-waiting">
        {prompt.title}
      </strong>
      {prompt.kind === "questions" ? (
        <QuestionsForm
          prompt={prompt}
          explanations={open.explanations}
          onAnswer={answer}
          onExplain={(questionId, value, question) => {
            handlers.explain(prompt.id, questionId, value, question);
          }}
        />
      ) : (
        <SimplePrompt prompt={prompt} onAnswer={answer} />
      )}
    </section>
  );
}

function SimplePrompt({
  prompt,
  onAnswer,
}: {
  readonly prompt: Exclude<Prompt, { kind: "questions" }>;
  readonly onAnswer: (value: Answer) => void;
}): ReactElement {
  const [text, setText] = useState(
    prompt.kind === "editor" ? (prompt.prefill ?? "") : "",
  );

  const cancel = (
    <Button
      variant="ghost"
      onClick={() => {
        onAnswer(null);
      }}
    >
      Cancel
    </Button>
  );

  switch (prompt.kind) {
    case "confirm":
      return (
        <>
          <p className="text-prose whitespace-pre-wrap">{prompt.message}</p>
          <Actions>
            <Button
              variant="primary"
              onClick={() => {
                onAnswer(true);
              }}
            >
              Yes
            </Button>
            <Button
              onClick={() => {
                onAnswer(false);
              }}
            >
              No
            </Button>
          </Actions>
        </>
      );
    case "select":
      return (
        <Actions>
          {prompt.options.map((option) => (
            <Button
              key={option}
              onClick={() => {
                onAnswer(option);
              }}
            >
              {option}
            </Button>
          ))}
          {cancel}
        </Actions>
      );
    case "input":
    case "secret":
    case "editor":
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onAnswer(text);
          }}
          className="flex flex-col gap-3"
        >
          {prompt.kind === "editor" ? (
            <textarea
              aria-label={prompt.title}
              rows={8}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
              className={fieldClass}
            />
          ) : (
            <input
              type={prompt.kind === "secret" ? "password" : "text"}
              aria-label={prompt.title}
              autoComplete="off"
              placeholder={prompt.placeholder ?? ""}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
              className={fieldClass}
            />
          )}
          <Actions>
            <Button variant="primary" type="submit">
              Submit
            </Button>
            {cancel}
          </Actions>
        </form>
      );
  }
}
