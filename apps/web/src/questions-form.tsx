import type {
  Answer,
  Prompt,
  Question,
  QuestionOption,
} from "@pi-cloud/protocol";
import { Button, cn, fieldClass, Icon } from "@pi-cloud/ui";
import { type ReactElement, useState } from "react";
import type { Explanation } from "./feed";
import { Actions } from "./fields";
import {
  answered,
  answerOf,
  answersOf,
  initialState,
  move,
  otherValue,
  pick,
  type QuestionState,
  setNumber,
  summary,
  typeOther,
} from "./questions";

type QuestionsPrompt = Extract<Prompt, { kind: "questions" }>;
type ChoiceQuestion = Extract<Question, { options: unknown }>;
type NumberQuestion = Extract<Question, { type: "number" }>;

interface Asking {
  readonly enabled: boolean;
  readonly explanations: readonly Explanation[];
  readonly waiting: Readonly<Record<string, number>>;
  readonly ask: (questionId: string, value: string, text: string) => void;
}

const explanationKey = (questionId: string, value: string): string =>
  `${questionId}\u0000${value}`;

export function QuestionsForm({
  prompt,
  explanations,
  onAnswer,
  onExplain,
}: {
  readonly prompt: QuestionsPrompt;
  readonly explanations: readonly Explanation[];
  readonly onAnswer: (value: Answer) => void;
  readonly onExplain: (
    questionId: string,
    value: string,
    question: string | null,
  ) => void;
}): ReactElement {
  const { questions } = prompt;
  const [current, setCurrent] = useState(0);
  const [note, setNote] = useState("");

  const [states, setStates] = useState<Readonly<Record<string, QuestionState>>>(
    () => Object.fromEntries(questions.map((q) => [q.id, initialState(q)])),
  );

  const [waiting, setWaiting] = useState<Readonly<Record<string, number>>>({});
  const question = questions[current];
  const reviewing = current === questions.length;

  const stateOf = (q: Question): QuestionState =>
    states[q.id] ?? initialState(q);

  const change = (q: Question, next: QuestionState): void => {
    setStates({ ...states, [q.id]: next });
  };

  const asking: Asking = {
    enabled: prompt.explain,
    explanations,
    waiting,
    ask: (questionId, value, text) => {
      const key = explanationKey(questionId, value);

      setWaiting({
        ...waiting,
        [key]: explanations.filter(
          (e) => explanationKey(e.questionId, e.value) === key,
        ).length,
      });

      onExplain(questionId, value, text === "" ? null : text);
    },
  };

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Questions" className="flex flex-wrap gap-1">
        {[...questions, undefined].map((q, index) => (
          <button
            key={q?.id ?? "review"}
            type="button"
            aria-current={index === current ? "step" : undefined}
            onClick={() => {
              setCurrent(index);
            }}
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border border-line px-3 text-label text-fg-dim hover:bg-hover aria-[current=step]:border-accent aria-[current=step]:bg-accent-tint aria-[current=step]:text-fg-strong"
          >
            {q && answered(q, stateOf(q)) && (
              <Icon name="check" className="size-3.5 text-done" />
            )}
            {q?.label ?? "Review"}
          </button>
        ))}
      </nav>

      {question ? (
        <QuestionBody
          key={question.id}
          question={question}
          state={stateOf(question)}
          onChange={(next) => {
            change(question, next);
          }}
          asking={asking}
        />
      ) : (
        <Review
          questions={questions}
          stateOf={stateOf}
          note={note}
          onNote={setNote}
          onOpen={setCurrent}
        />
      )}

      <Actions>
        {current > 0 && (
          <Button
            onClick={() => {
              setCurrent(current - 1);
            }}
          >
            Back
          </Button>
        )}
        {reviewing ? (
          <Button
            variant="primary"
            onClick={() => {
              onAnswer(answersOf(questions, states, note));
            }}
          >
            Submit
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => {
              setCurrent(current + 1);
            }}
          >
            {current === questions.length - 1 ? "Review answers" : "Next"}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => {
            onAnswer(null);
          }}
        >
          Cancel
        </Button>
      </Actions>
    </div>
  );
}

function QuestionBody({
  question,
  state,
  onChange,
  asking,
}: {
  readonly question: Question;
  readonly state: QuestionState;
  readonly onChange: (state: QuestionState) => void;
  readonly asking: Asking;
}): ReactElement {
  const input = (): ReactElement => {
    switch (question.type) {
      case "single":
      case "multi":
        return (
          <Choices
            question={question}
            state={state}
            onChange={onChange}
            asking={asking}
          />
        );
      case "scale":
        return (
          <Scale
            question={question}
            state={state}
            onChange={onChange}
            asking={asking}
          />
        );
      case "rank":
        return (
          <Rank
            question={question}
            state={state}
            onChange={onChange}
            asking={asking}
          />
        );
      case "number":
        return (
          <NumberInput question={question} state={state} onChange={onChange} />
        );
      case "text":
        return (
          <textarea
            aria-label={question.prompt}
            rows={4}
            placeholder={question.placeholder ?? ""}
            value={state.text}
            onChange={(event) => {
              onChange({ ...state, text: event.target.value });
            }}
            className={fieldClass}
          />
        );
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-title font-semibold text-fg-strong">
        {question.prompt}
      </h2>
      {question.context !== null && (
        <p className="text-ui whitespace-pre-wrap text-fg-dim">
          {question.context}
        </p>
      )}
      {input()}
    </div>
  );
}

function Split({
  children,
  detail,
}: {
  readonly children: ReactElement;
  readonly detail: ReactElement;
}): ReactElement {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {children}
      {detail}
    </div>
  );
}

function Annotation({
  state,
  value,
  onChange,
}: {
  readonly state: QuestionState;
  readonly value: string;
  readonly onChange: (state: QuestionState) => void;
}): ReactElement {
  return (
    <input
      aria-label="Note for this choice"
      placeholder="Add a note to this choice"
      value={state.annotations[value] ?? ""}
      onChange={(event) => {
        onChange({
          ...state,
          annotations: { ...state.annotations, [value]: event.target.value },
        });
      }}
      className={cn(fieldClass, "py-1 text-label")}
    />
  );
}

function OptionLabel({
  option,
}: {
  readonly option: QuestionOption;
}): ReactElement {
  return (
    <>
      {option.label}
      {option.recommended && (
        <span className="text-waiting" title="Recommended">
          {" "}
          ★
        </span>
      )}
    </>
  );
}

function Choices({
  question,
  state,
  onChange,
  asking,
}: {
  readonly question: ChoiceQuestion;
  readonly state: QuestionState;
  readonly onChange: (state: QuestionState) => void;
  readonly asking: Asking;
}): ReactElement {
  const [hovered, setHovered] = useState<string>();
  const multi = question.type === "multi";

  const shown = question.options.find(
    (option) =>
      option.value ===
      (hovered ?? state.picked.findLast((value) => value !== otherValue)),
  );

  const otherChosen = state.picked.includes(otherValue);

  return (
    <Split
      detail={<Detail question={question} option={shown} asking={asking} />}
    >
      <ul className="flex flex-col gap-1.5">
        {question.options.map((option) => {
          const chosen = state.picked.includes(option.value);

          return (
            <li
              key={option.value}
              onMouseEnter={() => {
                setHovered(option.value);
              }}
              className={cn(
                "flex flex-col gap-2 rounded-md border px-3 py-2",
                chosen ? "border-accent bg-accent-tint" : "border-line",
              )}
            >
              <label className="flex cursor-pointer items-center gap-2.5 text-ui">
                <input
                  type={multi ? "checkbox" : "radio"}
                  name={question.id}
                  checked={chosen}
                  onChange={() => {
                    setHovered(option.value);
                    onChange(pick(question, state, option.value));
                  }}
                  className="accent-accent"
                />
                <span>
                  <OptionLabel option={option} />
                </span>
              </label>
              {chosen && (
                <Annotation
                  state={state}
                  value={option.value}
                  onChange={onChange}
                />
              )}
            </li>
          );
        })}
        <li
          className={cn(
            "rounded-md border px-3 py-2",
            otherChosen ? "border-accent bg-accent-tint" : "border-line",
          )}
        >
          <input
            aria-label="Other answer"
            placeholder="Other: type your own…"
            value={state.other}
            onChange={(event) => {
              onChange(typeOther(question, state, event.target.value));
            }}
            className={cn(
              fieldClass,
              "w-full border-transparent bg-transparent px-0",
            )}
          />
        </li>
      </ul>
    </Split>
  );
}

function Scale({
  question,
  state,
  onChange,
  asking,
}: {
  readonly question: ChoiceQuestion;
  readonly state: QuestionState;
  readonly onChange: (state: QuestionState) => void;
  readonly asking: Asking;
}): ReactElement {
  const index = Math.max(
    0,
    question.options.findIndex((option) => option.value === state.picked[0]),
  );

  const option = question.options[index];

  const choose = (at: number): void => {
    const picked = question.options[at];
    if (picked) {
      onChange(pick(question, state, picked.value));
    }
  };

  return (
    <Split
      detail={<Detail question={question} option={option} asking={asking} />}
    >
      <div className="flex flex-col gap-3">
        <input
          type="range"
          aria-label={question.prompt}
          min={0}
          max={question.options.length - 1}
          step={1}
          value={index}
          onChange={(event) => {
            choose(Number(event.target.value));
          }}
          className="w-full accent-accent"
        />
        <div className="flex justify-between gap-1">
          {question.options.map((o, at) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                choose(at);
              }}
              className={cn(
                "cursor-pointer text-caption",
                at === index ? "font-semibold text-fg-strong" : "text-fg-dim",
              )}
            >
              <OptionLabel option={o} />
            </button>
          ))}
        </div>
        {option && (
          <Annotation state={state} value={option.value} onChange={onChange} />
        )}
      </div>
    </Split>
  );
}

function Rank({
  question,
  state,
  onChange,
  asking,
}: {
  readonly question: ChoiceQuestion;
  readonly state: QuestionState;
  readonly onChange: (state: QuestionState) => void;
  readonly asking: Asking;
}): ReactElement {
  const [focused, setFocused] = useState<string>();
  const [dragged, setDragged] = useState<number>();
  const shown = question.options.find((option) => option.value === focused);

  return (
    <Split
      detail={<Detail question={question} option={shown} asking={asking} />}
    >
      <ol className="flex flex-col gap-1.5">
        {state.picked.map((value, at) => {
          const option = question.options.find((o) => o.value === value);
          if (!option) {
            return null;
          }

          return (
            <li
              key={value}
              draggable
              onDragStart={() => {
                setDragged(at);
              }}
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragged !== undefined && dragged !== at) {
                  onChange(move(state, dragged, at));
                }
              }}
              className={cn(
                "flex cursor-grab flex-col gap-2 rounded-md border px-3 py-1.5",
                focused === value
                  ? "border-accent bg-accent-tint"
                  : "border-line",
              )}
            >
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="text-fg-dim">
                  ⋮⋮
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setFocused(value);
                  }}
                  className="flex-1 cursor-pointer text-left text-ui"
                >
                  {at + 1}. <OptionLabel option={option} />
                </button>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label="Move up"
                  disabled={at === 0}
                  onClick={() => {
                    onChange(move(state, at, at - 1));
                    setFocused(value);
                  }}
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label="Move down"
                  disabled={at === state.picked.length - 1}
                  onClick={() => {
                    onChange(move(state, at, at + 1));
                    setFocused(value);
                  }}
                >
                  ↓
                </Button>
              </div>
              {focused === value && (
                <Annotation state={state} value={value} onChange={onChange} />
              )}
            </li>
          );
        })}
      </ol>
    </Split>
  );
}

function NumberInput({
  question,
  state,
  onChange,
}: {
  readonly question: NumberQuestion;
  readonly state: QuestionState;
  readonly onChange: (state: QuestionState) => void;
}): ReactElement {
  const unit = question.unit === null ? "" : ` ${question.unit}`;

  const set = (value: number): void => {
    onChange(setNumber(question, state, value));
  };

  const bounds = {
    min: question.min,
    max: question.max,
    step: question.step,
    value: state.value,
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-caption text-fg-dim">
        <span className="whitespace-nowrap">
          {question.min}
          {unit}
        </span>
        <input
          type="range"
          aria-label={question.prompt}
          {...bounds}
          onChange={(event) => {
            set(Number(event.target.value));
          }}
          className="w-full accent-accent"
        />
        <span className="whitespace-nowrap">
          {question.max}
          {unit}
        </span>
      </div>
      <label className="flex items-center gap-2 text-ui">
        <input
          type="number"
          aria-label={`${question.prompt} (value)`}
          {...bounds}
          onChange={(event) => {
            set(Number(event.target.value));
          }}
          className={cn(fieldClass, "w-28")}
        />
        {unit}
      </label>
      {question.recommended !== null && (
        <div>
          <Button
            variant="ghost"
            onClick={() => {
              if (question.recommended !== null) {
                set(question.recommended);
              }
            }}
          >
            ★ Recommended: {question.recommended}
            {unit}
          </Button>
        </div>
      )}
    </div>
  );
}

function Detail({
  question,
  option,
  asking,
}: {
  readonly question: ChoiceQuestion;
  readonly option: QuestionOption | undefined;
  readonly asking: Asking;
}): ReactElement {
  const [text, setText] = useState("");

  if (!option) {
    return (
      <div className="border-l-3 border-line pl-3 text-label text-fg-dim">
        Pick or hover an option to see its details.
      </div>
    );
  }

  const key = explanationKey(question.id, option.value);

  const found = asking.explanations.filter(
    (e) => explanationKey(e.questionId, e.value) === key,
  );

  const waiting =
    key in asking.waiting && found.length <= (asking.waiting[key] ?? 0);

  return (
    <div className="flex flex-col gap-2 border-l-3 border-line pl-3 text-ui">
      <h3 className="font-semibold text-fg-strong">{option.label}</h3>
      {option.recommended && (
        <p className="text-label font-semibold text-waiting">★ Recommended</p>
      )}
      {option.description !== null && (
        <p className="whitespace-pre-wrap">{option.description}</p>
      )}
      {asking.enabled && (
        <>
          {found.map((entry, at) => (
            <div
              key={`${String(at)}-${entry.question ?? ""}`}
              className="flex flex-col gap-1 rounded-md bg-code p-2"
            >
              <small className="text-caption text-fg-dim">
                {entry.question ?? "Explanation"}
              </small>
              <p
                className={cn(
                  "whitespace-pre-wrap",
                  entry.error !== null && "text-failed",
                )}
              >
                {entry.text ?? entry.error ?? ""}
              </p>
            </div>
          ))}
          {waiting && <p className="text-label text-fg-dim">Thinking…</p>}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              asking.ask(question.id, option.value, text.trim());
              setText("");
            }}
            className="flex gap-2"
          >
            <input
              aria-label="Ask about this option"
              placeholder="Ask about this option (empty explains it)"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
              className={cn(fieldClass, "min-w-0 flex-1")}
            />
            <Button type="submit">Ask</Button>
          </form>
        </>
      )}
    </div>
  );
}

function Review({
  questions,
  stateOf,
  note,
  onNote,
  onOpen,
}: {
  readonly questions: readonly Question[];
  readonly stateOf: (question: Question) => QuestionState;
  readonly note: string;
  readonly onNote: (note: string) => void;
  readonly onOpen: (index: number) => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-title font-semibold text-fg-strong">
        Review your answers
      </h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-ui">
        {questions.map((question, index) => (
          <div key={question.id} className="contents">
            <dt>
              <button
                type="button"
                onClick={() => {
                  onOpen(index);
                }}
                className="cursor-pointer text-fg-dim hover:text-fg hover:underline"
              >
                {question.label}
              </button>
            </dt>
            <dd>{summary(question, answerOf(question, stateOf(question)))}</dd>
          </div>
        ))}
      </dl>
      <textarea
        aria-label="Note for the agent"
        rows={3}
        placeholder="Anything else the agent should know?"
        value={note}
        onChange={(event) => {
          onNote(event.target.value);
        }}
        className={fieldClass}
      />
    </div>
  );
}
