import type { Prompt } from "@pi-cloud/protocol";

type Answer = string | boolean | null;

function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

export function renderPrompt(
  prompt: Prompt,
  answer: (value: Answer) => void,
): HTMLElement {
  const box = document.createElement("li");
  box.dataset["role"] = "prompt";
  const title = document.createElement("strong");
  title.textContent = prompt.title;
  box.append(title);
  const actions = document.createElement("div");
  switch (prompt.kind) {
    case "confirm": {
      const message = document.createElement("p");
      message.textContent = prompt.message;
      box.append(message);
      actions.append(
        button("Yes", () => {
          answer(true);
        }),
        button("No", () => {
          answer(false);
        }),
      );
      break;
    }
    case "select":
      actions.append(
        ...prompt.options.map((option) =>
          button(option, () => {
            answer(option);
          }),
        ),
        button("Cancel", () => {
          answer(null);
        }),
      );
      break;
    case "input":
    case "editor": {
      const field = document.createElement("textarea");
      field.rows = prompt.kind === "editor" ? 8 : 1;
      if (prompt.kind === "input") {
        field.placeholder = prompt.placeholder ?? "";
      } else {
        field.value = prompt.prefill ?? "";
      }
      box.append(field);
      actions.append(
        button("Submit", () => {
          answer(field.value);
        }),
        button("Cancel", () => {
          answer(null);
        }),
      );
      break;
    }
  }
  box.append(actions);
  return box;
}
