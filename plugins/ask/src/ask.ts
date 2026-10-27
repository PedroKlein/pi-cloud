import {
  type Api,
  type Model,
  StringEnum,
  Type,
  type Static,
} from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  Question,
  QuestionAnswer,
  QuestionsAnswer,
} from "@pipoca/protocol";
import type { AskQuestions, Explain } from "@pipoca/plugins";

const OptionSchema = Type.Object({
  value: Type.String({ description: "Value identifier for this option" }),
  label: Type.String({ description: "Display label" }),
  description: Type.Optional(
    Type.String({
      description:
        "Shown in the detail panel when the option is highlighted. Always provide this.",
    }),
  ),
  recommended: Type.Optional(
    Type.Boolean({ description: "Mark as recommended (shows a ★ badge)" }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique question identifier" }),
  label: Type.Optional(
    Type.String({
      description: "Short tab label (2-3 words), defaults to Q1, Q2...",
    }),
  ),
  prompt: Type.String({ description: "Full question text" }),
  type: StringEnum(
    ["single", "multi", "scale", "rank", "text", "number"] as const,
    {
      description:
        "single=pick one, multi=pick many, scale=pick one point on an ordered range, rank=put options in order, text=free input, number=pick a number on a slider",
    },
  ),
  context: Type.Optional(
    Type.String({ description: "Help text shown below the question" }),
  ),
  options: Type.Optional(
    Type.Array(OptionSchema, {
      description:
        "Choices for single, multi, scale (in order, low to high) and rank. Omit for text and number.",
    }),
  ),
  placeholder: Type.Optional(
    Type.String({ description: "Placeholder for text questions" }),
  ),
  min: Type.Optional(Type.Number({ description: "Lowest number (number)" })),
  max: Type.Optional(Type.Number({ description: "Highest number (number)" })),
  step: Type.Optional(
    Type.Number({ description: "Slider step (number), defaults to 1" }),
  ),
  unit: Type.Optional(
    Type.String({ description: "Unit shown next to the number, like GB" }),
  ),
  recommendedValue: Type.Optional(
    Type.Number({ description: "Recommended number (number)" }),
  ),
});

const AskUserParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: "One or more questions to present to the user",
  }),
});

type RawQuestion = Static<typeof QuestionSchema>;

export function askUserTool(ask: AskQuestions): ToolDefinition {
  return defineTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Present structured questions to the user as an interactive form. " +
      "Use this tool whenever you need the user to choose between options, confirm decisions, or provide input. " +
      "Supports single choice, multiple choice, a point on an ordered scale, ranking, free text and numbers on a slider. " +
      "Users can annotate their choices, add their own option, and ask about an option before answering. " +
      "Always provide a description for each option: it is shown in the detail panel when the option is highlighted.",
    promptSnippet:
      "Ask the user structured questions in a form (single/multi choice, scale, rank, text, number)",
    promptGuidelines: [
      "ALWAYS use ask_user when you need user input on choices or decisions. Never list options as plain text and ask the user to pick.",
      "Provide a meaningful 'description' for EVERY option, it is shown in a detail panel and helps the user decide.",
      "Use 'recommended: true' on options you think are best, or 'recommendedValue' for numbers, with reasoning in the description or context.",
      "Use 'multi' when several options could apply, 'single' when exactly one must be chosen, 'scale' for a point on an ordered range, 'rank' to order options, 'number' for a quantity, and 'text' for open-ended questions.",
      "For questions that need context or explanation, present the context in your chat message before calling ask_user. Keep the 'prompt' field short (one line).",
    ],
    parameters: AskUserParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions = params.questions.map(normalize);
      if (questions.length === 0) {
        throw new Error("No questions provided.");
      }

      const answer = await ask(questions, explainer(ctx, questions), signal);

      return {
        content: [{ type: "text", text: describe(questions, answer) }],
        details: { questions, answer },
      };
    },
  });
}

function normalize(raw: RawQuestion, index: number): Question {
  const base = {
    id: raw.id,
    label: raw.label ?? `Q${String(index + 1)}`,
    prompt: raw.prompt,
    context: raw.context ?? null,
  };

  switch (raw.type) {
    case "single":
    case "multi":
    case "scale":
    case "rank": {
      const options = raw.options ?? [];
      if (options.length === 0) {
        throw new Error(
          `Question "${raw.id}" is type "${raw.type}" but has no options.`,
        );
      }

      return {
        ...base,
        type: raw.type,
        options: options.map((option) => ({
          value: option.value,
          label: option.label,
          description: option.description ?? null,
          recommended: option.recommended === true,
        })),
      };
    }

    case "text":
      return { ...base, type: "text", placeholder: raw.placeholder ?? null };
    case "number": {
      if (raw.min === undefined || raw.max === undefined) {
        throw new Error(
          `Question "${raw.id}" is type "number" but has no min or max.`,
        );
      }

      const step = raw.step ?? 1;

      if (step <= 0) {
        throw new Error(
          `Question "${raw.id}" has step ${String(step)}; step must be above 0.`,
        );
      }

      if (raw.min > raw.max) {
        throw new Error(
          `Question "${raw.id}" has min ${String(raw.min)} above max ${String(raw.max)}.`,
        );
      }

      return {
        ...base,
        type: "number",
        min: raw.min,
        max: raw.max,
        step,
        unit: raw.unit ?? null,
        recommended: raw.recommendedValue ?? null,
      };
    }
  }
}

function explainer(
  ctx: ExtensionToolContext,
  questions: readonly Question[],
): Explain | undefined {
  const model: Model<Api> | undefined = ctx.model;
  if (model === undefined) {
    return undefined;
  }

  return async (questionId, value, question) => {
    const asked = questions.find((q) => q.id === questionId);
    const options = asked && "options" in asked ? asked.options : [];

    const option = options.find((o) => o.value === value);
    if (!asked || !option) {
      throw new Error(`no option ${value} in question ${questionId}`);
    }

    const others = options
      .filter((o) => o !== option)
      .map((o) => o.label)
      .join(", ");

    const prompt = [
      `Question being answered: "${asked.prompt}"`,
      `Option: "${option.label}"`,
      option.description === null
        ? ""
        : `Option details: ${option.description}`,
      others === "" ? "" : `Other options: ${others}`,
      asked.context === null ? "" : `Context: ${asked.context}`,
      "",
      question === null
        ? "Explain this option concisely: trade-offs, when it's a good or bad fit, and how it compares to the alternatives. 2-3 short paragraphs at most."
        : `The user's question about this option: ${question}\n\nAnswer concisely in 2-3 short paragraphs.`,
    ]
      .filter((line, i, lines) => line !== "" || lines[i - 1] !== "")
      .join("\n");

    const response = await ctx.modelRegistry
      .streamSimple(model, {
        systemPrompt:
          "You explain options for decision-making. Be concise and practical. No markdown formatting.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      })
      .result();

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage ?? "the model did not answer");
    }

    return response.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim();
  };
}

function describe(
  questions: readonly Question[],
  answer: QuestionsAnswer | null,
): string {
  if (answer === null) {
    return "User cancelled the questionnaire without answering. Proceed with your best judgment: use recommended options where specified, make reasonable choices elsewhere.";
  }

  const lines = answer.answers.flatMap((given) => {
    const question = questions.find((q) => q.id === given.id);

    return question ? describeAnswer(question, given) : [];
  });

  if (answer.note !== null && answer.note.trim() !== "") {
    lines.push(`- Additional notes: ${answer.note.trim()}`);
  }

  return lines.length === 0
    ? "User submitted with no answers."
    : ["User answers:", ...lines].join("\n");
}

function describeAnswer(question: Question, given: QuestionAnswer): string[] {
  const { label } = question;

  switch (given.type) {
    case "text":
      return given.text.trim() === ""
        ? []
        : [`- ${label}: ${given.text.trim()}`];
    case "number": {
      const unit =
        question.type === "number" && question.unit !== null
          ? ` ${question.unit}`
          : "";

      return [`- ${label}: ${String(given.value)}${unit}`];
    }

    case "choice": {
      const name = (selection: (typeof given.selections)[number]): string =>
        `${selection.label}${selection.custom ? " (custom)" : ""}`;

      const note = (selection: (typeof given.selections)[number]): string[] =>
        selection.annotation === null || selection.annotation.trim() === ""
          ? []
          : [`    → "${selection.annotation.trim()}"`];

      if (question.type === "rank") {
        const order = given.selections
          .map((selection, i) => `${String(i + 1)}. ${name(selection)}`)
          .join(", ");

        return [`- ${label}: ${order}`, ...given.selections.flatMap(note)];
      }

      return given.selections.flatMap((selection) => [
        `- ${label}: ${name(selection)}`,
        ...note(selection),
      ]);
    }
  }
}
