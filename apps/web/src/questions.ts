import type {
  Question,
  QuestionAnswer,
  QuestionsAnswer,
  Selection,
} from "@pi-cloud/protocol";

// What a person has entered for one question so far.
export interface QuestionState {
  readonly picked: readonly string[];
  readonly annotations: Readonly<Record<string, string>>;
  readonly other: string;
  readonly text: string;
  readonly value: number;
  readonly touched: boolean;
}

export const otherValue = "\u0000other";

export function initialState(question: Question): QuestionState {
  const state: QuestionState = {
    picked: [],
    annotations: {},
    other: "",
    text: "",
    value: 0,
    touched: false,
  };

  switch (question.type) {
    case "rank":
      return { ...state, picked: question.options.map(({ value }) => value) };
    case "scale": {
      const recommended =
        question.options.find((option) => option.recommended) ??
        question.options[Math.floor(question.options.length / 2)];

      return { ...state, picked: recommended ? [recommended.value] : [] };
    }

    case "number": {
      const value =
        question.recommended ??
        question.min +
          Math.round((question.max - question.min) / 2 / question.step) *
            question.step;

      return { ...state, value, text: String(value) };
    }

    case "single":
    case "multi":
    case "text":
      return state;
  }
}

export function pick(
  question: Question,
  state: QuestionState,
  value: string,
): QuestionState {
  if (question.type !== "multi") {
    return { ...state, picked: [value], touched: true };
  }

  return {
    ...state,
    picked: state.picked.includes(value)
      ? state.picked.filter((picked) => picked !== value)
      : [...state.picked, value],
    touched: true,
  };
}

export function typeOther(
  question: Question,
  state: QuestionState,
  other: string,
): QuestionState {
  const typed = { ...state, other };

  return other === "" || state.picked.includes(otherValue)
    ? typed
    : pick(question, typed, otherValue);
}

export function move(
  state: QuestionState,
  from: number,
  to: number,
): QuestionState {
  const value = state.picked[from];
  if (value === undefined || to < 0 || to >= state.picked.length) {
    return state;
  }

  const picked = state.picked.filter((_, at) => at !== from);
  picked.splice(to, 0, value);

  return { ...state, picked, touched: true };
}

export function setNumber(
  question: Extract<Question, { type: "number" }>,
  state: QuestionState,
  value: number,
): QuestionState {
  if (!Number.isFinite(value)) {
    return state;
  }

  const clamped = Math.min(question.max, Math.max(question.min, value));

  return { ...state, value: clamped, text: String(clamped), touched: true };
}

// The number box shows what was typed, so "5" on the way to "50" isn't
// clamped away while the value stays in range.
export function typeNumber(
  question: Extract<Question, { type: "number" }>,
  state: QuestionState,
  text: string,
): QuestionState {
  const value = text.trim() === "" ? Number.NaN : Number(text);

  return { ...setNumber(question, state, value), text };
}

export function answered(question: Question, state: QuestionState): boolean {
  switch (question.type) {
    case "text":
      return state.text.trim() !== "";
    case "number":
    case "scale":
    case "rank":
      return state.touched;
    case "single":
    case "multi":
      return state.picked.some(
        (value) => value !== otherValue || state.other.trim() !== "",
      );
  }
}

export function answerOf(
  question: Question,
  state: QuestionState,
): QuestionAnswer {
  switch (question.type) {
    case "text":
      return { id: question.id, type: "text", text: state.text };
    case "number":
      return { id: question.id, type: "number", value: state.value };
    case "single":
    case "multi":
    case "scale":
    case "rank": {
      const selections = state.picked.flatMap((value): Selection[] => {
        const note = state.annotations[value]?.trim() ?? "";
        const annotation = note === "" ? null : note;

        if (value === otherValue) {
          const other = state.other.trim();

          return other === ""
            ? []
            : [{ value: other, label: other, custom: true, annotation }];
        }

        const option = question.options.find((o) => o.value === value);

        return option
          ? [{ value, label: option.label, custom: false, annotation }]
          : [];
      });

      return { id: question.id, type: "choice", selections };
    }
  }
}

export function answersOf(
  questions: readonly Question[],
  states: Readonly<Record<string, QuestionState>>,
  note: string,
): QuestionsAnswer {
  return {
    answers: questions.map((question) =>
      answerOf(question, states[question.id] ?? initialState(question)),
    ),
    note: note.trim() === "" ? null : note.trim(),
  };
}

export function summary(question: Question, answer: QuestionAnswer): string {
  switch (answer.type) {
    case "text":
      return answer.text.trim() === "" ? "No answer" : answer.text.trim();
    case "number":
      return `${String(answer.value)}${question.type === "number" && question.unit !== null ? ` ${question.unit}` : ""}`;
    case "choice":
      return answer.selections.length === 0
        ? "No answer"
        : answer.selections
            .map(
              (selection, i) =>
                `${question.type === "rank" ? `${String(i + 1)}. ` : ""}${selection.label}${selection.annotation === null ? "" : ` (“${selection.annotation}”)`}`,
            )
            .join(question.type === "rank" ? "  " : ", ");
  }
}
