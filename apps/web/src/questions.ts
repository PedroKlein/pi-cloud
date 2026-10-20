import type {
  LiveEvent,
  Prompt,
  Question,
  QuestionAnswer,
  QuestionOption,
  QuestionsAnswer,
  Selection,
} from "@pi-cloud/protocol";

type QuestionsPrompt = Extract<Prompt, { kind: "questions" }>;
type Explanation = Extract<LiveEvent, { type: "explanation" }>;
type ChoiceQuestion = Extract<Question, { options: unknown }>;

export interface QuestionsForm {
  readonly element: HTMLElement;
  readonly explained: (event: Explanation) => void;
}

interface Handlers {
  readonly answer: (value: QuestionsAnswer | null) => void;
  readonly explain: (
    questionId: string,
    value: string,
    question: string | null,
  ) => void;
}

interface State {
  readonly picked: string[];
  readonly annotations: Map<string, string>;
  other: string;
  text: string;
  value: number;
  touched: boolean;
}

const otherValue = "\u0000other";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Pick<HTMLElement, "className" | "textContent" | "title">> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);

  return node;
}

function button(
  label: string,
  onClick: () => void,
  className = "",
): HTMLButtonElement {
  const node = el("button", { className, textContent: label });
  node.type = "button";
  node.addEventListener("click", onClick);

  return node;
}

function initialState(question: Question): State {
  const state: State = {
    picked: [],
    annotations: new Map(),
    other: "",
    text: "",
    value: 0,
    touched: false,
  };

  switch (question.type) {
    case "rank":
      state.picked.push(...question.options.map((option) => option.value));

      break;
    case "scale": {
      const recommended =
        question.options.find((option) => option.recommended) ??
        question.options[Math.floor(question.options.length / 2)];

      if (recommended) {
        state.picked.push(recommended.value);
      }

      break;
    }

    case "number":
      state.value =
        question.recommended ??
        question.min +
          Math.round((question.max - question.min) / 2 / question.step) *
            question.step;

      break;
    case "single":
    case "multi":
    case "text":
      break;
  }

  return state;
}

function answerOf(question: Question, state: State): QuestionAnswer {
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
        const annotation = state.annotations.get(value)?.trim() ?? "";

        if (value === otherValue) {
          return state.other.trim() === ""
            ? []
            : [
                {
                  value: state.other.trim(),
                  label: state.other.trim(),
                  custom: true,
                  annotation: annotation === "" ? null : annotation,
                },
              ];
        }

        const option = question.options.find((o) => o.value === value);

        return option
          ? [
              {
                value,
                label: option.label,
                custom: false,
                annotation: annotation === "" ? null : annotation,
              },
            ]
          : [];
      });

      return { id: question.id, type: "choice", selections };
    }
  }
}

function summary(question: Question, answer: QuestionAnswer): string {
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

function answered(question: Question, state: State): boolean {
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

export function renderQuestions(
  prompt: QuestionsPrompt,
  handlers: Handlers,
): QuestionsForm {
  const { questions } = prompt;
  const states = new Map(questions.map((q) => [q.id, initialState(q)]));
  const explanations = new Map<string, Explanation[]>();
  const waiting = new Set<string>();
  const focus = new Map<string, string>();
  let current = 0;
  let note = "";

  const state = (question: Question): State => {
    const found = states.get(question.id);
    if (!found) {
      throw new Error(`no state for ${question.id}`);
    }

    return found;
  };

  const box = el("li", { className: "questions" });
  box.dataset["role"] = "prompt";
  const tabs = el("nav", { className: "tabs" });
  const body = el("div", { className: "question" });
  const footer = el("div", { className: "actions" });
  box.append(el("strong", { textContent: prompt.title }), tabs, body, footer);

  const show = (index: number): void => {
    current = index;
    render();
  };

  const submit = (): void => {
    handlers.answer({
      answers: questions.map((q) => answerOf(q, state(q))),
      note: note.trim() === "" ? null : note.trim(),
    });
  };

  const renderTabs = (): void => {
    tabs.replaceChildren(
      ...questions.map((question, i) => {
        const done = answered(question, state(question));

        const tab = button(
          `${done ? "✓ " : ""}${question.label}`,
          () => {
            show(i);
          },
          i === current ? "tab current" : "tab",
        );

        tab.setAttribute("aria-current", String(i === current));

        return tab;
      }),
      button(
        "Review",
        () => {
          show(questions.length);
        },
        current === questions.length ? "tab current" : "tab",
      ),
    );
  };

  const renderFooter = (): void => {
    const onReview = current === questions.length;

    footer.replaceChildren(
      ...(current > 0
        ? [
            button("Back", () => {
              show(current - 1);
            }),
          ]
        : []),
      onReview
        ? button("Submit", submit, "primary")
        : button(
            current === questions.length - 1 ? "Review" : "Next",
            () => {
              show(current + 1);
            },
            "primary",
          ),
      button(
        "Cancel",
        () => {
          handlers.answer(null);
        },
        "quiet",
      ),
    );
  };

  const renderDetail = (
    question: ChoiceQuestion,
    option: QuestionOption | undefined,
  ): HTMLElement => {
    const panel = el("aside", { className: "detail" });
    if (!option) {
      panel.append(
        el("p", {
          className: "hint",
          textContent: "Pick or hover an option to see its details.",
        }),
      );

      return panel;
    }

    panel.append(el("h4", { textContent: option.label }));
    if (option.recommended) {
      panel.append(
        el("p", { className: "star", textContent: "★ Recommended" }),
      );
    }

    if (option.description !== null) {
      panel.append(el("p", { textContent: option.description }));
    }

    if (!prompt.explain) {
      return panel;
    }

    const key = `${question.id}\u0000${option.value}`;

    for (const entry of explanations.get(key) ?? []) {
      const item = el("div", { className: "explanation" });

      item.append(
        el("small", {
          textContent: entry.question ?? "Explanation",
        }),
        el("p", {
          className: entry.error === null ? "" : "error",
          textContent: entry.text ?? entry.error ?? "",
        }),
      );

      panel.append(item);
    }

    if (waiting.has(key)) {
      panel.append(el("p", { className: "hint", textContent: "Thinking…" }));
    }

    const ask = el("form", { className: "ask" });
    const field = el("input");
    field.placeholder = "Ask about this option (empty explains it)";
    ask.append(field, el("button", { textContent: "Ask" }));

    ask.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = field.value.trim();
      waiting.add(key);
      handlers.explain(question.id, option.value, text === "" ? null : text);
      render();
    });

    panel.append(ask);

    return panel;
  };

  const annotation = (target: State, value: string): HTMLElement => {
    const field = el("input", { className: "annotation" });
    field.placeholder = "Add a note to this choice";
    field.value = target.annotations.get(value) ?? "";

    field.addEventListener("input", () => {
      target.annotations.set(value, field.value);
    });

    return field;
  };

  const renderChoices = (question: ChoiceQuestion): HTMLElement => {
    const target = state(question);

    const highlighted = question.options.find(
      (option) =>
        option.value ===
        (focus.get(question.id) ??
          target.picked.findLast((value) => value !== otherValue)),
    );

    const list = el("ul", { className: "options" });
    const layout = el("div", { className: "split" });
    layout.append(list, renderDetail(question, highlighted));

    const pick = (value: string): void => {
      if (question.type === "multi") {
        const at = target.picked.indexOf(value);
        if (at === -1) {
          target.picked.push(value);
        } else {
          target.picked.splice(at, 1);
        }
      } else {
        target.picked.splice(0, target.picked.length, value);
      }

      target.touched = true;
      focus.set(question.id, value);
      render();
    };

    for (const option of question.options) {
      const chosen = target.picked.includes(option.value);
      const row = el("li", { className: chosen ? "chosen" : "" });

      const marks = question.type === "multi" ? ["☐", "☑"] : ["○", "◉"];

      const choice = button(
        `${marks[Number(chosen)] ?? ""} ${option.label}${option.recommended ? " ★" : ""}`,
        () => {
          pick(option.value);
        },
        "choice",
      );

      choice.addEventListener("mouseenter", () => {
        if (focus.get(question.id) !== option.value) {
          focus.set(question.id, option.value);
          layout.lastElementChild?.replaceWith(renderDetail(question, option));
        }
      });

      row.append(choice);
      if (chosen) {
        row.append(annotation(target, option.value));
      }

      list.append(row);
    }

    const otherChosen = target.picked.includes(otherValue);
    const other = el("li", { className: otherChosen ? "chosen" : "" });
    const otherField = el("input");
    otherField.placeholder = "Other: type your own…";
    otherField.value = target.other;

    otherField.addEventListener("input", () => {
      target.other = otherField.value;
      if (!target.picked.includes(otherValue) && otherField.value !== "") {
        if (question.type === "multi") {
          target.picked.push(otherValue);
        } else {
          target.picked.splice(0, target.picked.length, otherValue);
        }

        renderTabs();
      }
    });

    other.append(otherField);
    list.append(other);

    return layout;
  };

  const renderScale = (question: ChoiceQuestion): HTMLElement => {
    const target = state(question);

    const index = Math.max(
      0,
      question.options.findIndex((option) => option.value === target.picked[0]),
    );

    const option = question.options[index];
    const layout = el("div", { className: "split" });
    const left = el("div", { className: "scale" });
    const slider = el("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = String(question.options.length - 1);
    slider.step = "1";
    slider.value = String(index);

    slider.addEventListener("input", () => {
      const picked = question.options[Number(slider.value)];
      if (picked) {
        target.picked.splice(0, target.picked.length, picked.value);
        target.touched = true;
        focus.delete(question.id);
        render();
      }
    });

    const ticks = el("div", { className: "ticks" });

    ticks.append(
      ...question.options.map((o, i) =>
        button(
          `${o.label}${o.recommended ? " ★" : ""}`,
          () => {
            slider.value = String(i);
            slider.dispatchEvent(new Event("input"));
          },
          i === index ? "tick current" : "tick",
        ),
      ),
    );

    left.append(slider, ticks);
    if (option) {
      left.append(annotation(target, option.value));
    }

    layout.append(left, renderDetail(question, option));

    return layout;
  };

  const renderRank = (question: ChoiceQuestion): HTMLElement => {
    const target = state(question);

    const highlighted = question.options.find(
      (option) => option.value === focus.get(question.id),
    );

    const list = el("ol", { className: "options rank" });
    const layout = el("div", { className: "split" });
    let dragged: number | undefined;

    const move = (from: number, to: number): void => {
      const [value] = target.picked.splice(from, 1);
      if (value !== undefined) {
        target.picked.splice(to, 0, value);
        target.touched = true;
        focus.set(question.id, value);
        render();
      }
    };

    target.picked.forEach((value, i) => {
      const option = question.options.find((o) => o.value === value);
      if (!option) {
        return;
      }

      const row = el("li");
      row.draggable = true;

      row.addEventListener("dragstart", () => {
        dragged = i;
      });

      row.addEventListener("dragover", (event) => {
        event.preventDefault();
      });

      row.addEventListener("drop", (event) => {
        event.preventDefault();
        if (dragged !== undefined && dragged !== i) {
          move(dragged, i);
        }
      });

      const label = button(
        `${String(i + 1)}. ${option.label}${option.recommended ? " ★" : ""}`,
        () => {
          focus.set(question.id, value);
          render();
        },
        "choice",
      );

      const up = button(
        "↑",
        () => {
          move(i, i - 1);
        },
        "quiet",
      );

      const down = button(
        "↓",
        () => {
          move(i, i + 1);
        },
        "quiet",
      );

      up.disabled = i === 0;
      down.disabled = i === target.picked.length - 1;
      up.title = "Move up";
      down.title = "Move down";

      row.append(
        el("span", { className: "grip", textContent: "⋮⋮" }),
        label,
        up,
        down,
      );

      if (focus.get(question.id) === value) {
        row.append(annotation(target, value));
      }

      list.append(row);
    });

    layout.append(list, renderDetail(question, highlighted));

    return layout;
  };

  const renderNumber = (
    question: Extract<Question, { type: "number" }>,
  ): HTMLElement => {
    const target = state(question);
    const wrap = el("div", { className: "number" });
    const slider = el("input");
    const field = el("input");
    const unit = question.unit === null ? "" : ` ${question.unit}`;

    for (const input of [slider, field]) {
      input.min = String(question.min);
      input.max = String(question.max);
      input.step = String(question.step);
      input.value = String(target.value);

      input.addEventListener("input", () => {
        const value = Number(input.value);
        if (Number.isFinite(value)) {
          target.value = Math.min(question.max, Math.max(question.min, value));
          target.touched = true;
          (input === slider ? field : slider).value = String(target.value);
          renderTabs();
        }
      });
    }

    slider.type = "range";
    field.type = "number";
    const row = el("div", { className: "row" });

    row.append(
      el("small", { textContent: `${String(question.min)}${unit}` }),
      slider,
      el("small", { textContent: `${String(question.max)}${unit}` }),
    );

    wrap.append(row, el("label", {}, field, unit));
    if (question.recommended !== null) {
      wrap.append(
        button(
          `★ Recommended: ${String(question.recommended)}${unit}`,
          () => {
            field.value = String(question.recommended);
            field.dispatchEvent(new Event("input"));
          },
          "quiet",
        ),
      );
    }

    return wrap;
  };

  const renderText = (
    question: Extract<Question, { type: "text" }>,
  ): HTMLElement => {
    const target = state(question);
    const field = el("textarea");
    field.rows = 4;
    field.placeholder = question.placeholder ?? "";
    field.value = target.text;

    field.addEventListener("input", () => {
      const wasAnswered = answered(question, target);
      target.text = field.value;
      if (wasAnswered !== answered(question, target)) {
        renderTabs();
      }
    });

    return field;
  };

  const renderQuestion = (question: Question): HTMLElement[] => {
    const parts: HTMLElement[] = [el("h3", { textContent: question.prompt })];
    if (question.context !== null) {
      parts.push(
        el("p", { className: "context", textContent: question.context }),
      );
    }

    switch (question.type) {
      case "single":
      case "multi":
        parts.push(renderChoices(question));

        break;
      case "scale":
        parts.push(renderScale(question));

        break;
      case "rank":
        parts.push(renderRank(question));

        break;
      case "number":
        parts.push(renderNumber(question));

        break;
      case "text":
        parts.push(renderText(question));

        break;
    }

    return parts;
  };

  const renderReview = (): HTMLElement[] => {
    const list = el("dl", { className: "review" });

    questions.forEach((question, i) => {
      const term = el("dt");

      term.append(
        button(
          question.label,
          () => {
            show(i);
          },
          "quiet",
        ),
      );

      list.append(
        term,
        el("dd", {
          textContent: summary(question, answerOf(question, state(question))),
        }),
      );
    });

    const field = el("textarea");
    field.rows = 3;
    field.placeholder = "Anything else the agent should know?";
    field.value = note;

    field.addEventListener("input", () => {
      note = field.value;
    });

    return [el("h3", { textContent: "Review your answers" }), list, field];
  };

  const render = (): void => {
    renderTabs();
    const question = questions[current];

    body.replaceChildren(
      ...(question ? renderQuestion(question) : renderReview()),
    );

    renderFooter();
  };

  render();

  return {
    element: box,
    explained: (event) => {
      const key = `${event.questionId}\u0000${event.value}`;
      waiting.delete(key);
      explanations.set(key, [...(explanations.get(key) ?? []), event]);
      render();
    },
  };
}
