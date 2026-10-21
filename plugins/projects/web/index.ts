import type { WebContext, WebPlugin } from "@pi-cloud/plugins/web";
import type { Environment } from "@pi-cloud/protocol";
import {
  type ProjectSummary,
  type ProjectView,
  type ThreadView,
  workStates,
} from "../src/model";

const refreshMs = 3000;

export const projects: WebPlugin = {
  name: "projects",
  nav: {
    label: "Projects",
    mount: (element, context) => {
      const view: View = { project: undefined, memoryFile: undefined };
      let shown = "";

      const render = async (): Promise<void> => {
        shown = "";

        element.replaceChildren(
          view.project === undefined
            ? await listPage(context, (id) => {
                view.project = id;
                void render();
              })
            : await projectPage(context, view, () => {
                view.project = undefined;
                view.memoryFile = undefined;
                void render();
              }),
        );
      };

      void render();

      // Thread states change on their own, so an open Project refreshes,
      // except while the user is typing into it.
      const timer = setInterval(() => {
        const typing =
          element.contains(document.activeElement) &&
          document.activeElement?.matches("input, textarea, select") === true;

        if (view.project === undefined || typing) {
          return;
        }

        // Rebuilding the page closes an open select, so only redraw on change.
        void context
          .request(`projects/${encodeURIComponent(view.project)}`)
          .then(async (response) => response.text())
          .then((text) => {
            if (shown !== "" && text !== shown) {
              void render();
            }

            shown = text;
          });
      }, refreshMs);

      return () => {
        clearInterval(timer);
      };
    },
  },
};

interface View {
  project: string | undefined;
  memoryFile: string | undefined;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) {
    element.textContent = text;
  }

  element.append(...children);

  return element;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const element = el("button", text);
  element.type = "button";
  element.addEventListener("click", onClick);

  return element;
}

async function listPage(
  context: WebContext,
  open: (id: string) => void,
): Promise<HTMLElement> {
  const list = (await (
    await context.request("projects")
  ).json()) as ProjectSummary[];

  const environments = (await (
    await fetch("/api/environments")
  ).json()) as Environment[];

  const items = el(
    "ul",
    undefined,
    ...list.map((project) =>
      el(
        "li",
        undefined,
        button(`${project.name} (${String(project.threads)} threads)`, () => {
          open(project.id);
        }),
      ),
    ),
  );

  const form = el("form");
  form.className = "project-create";

  const name = el("input");
  name.name = "name";
  name.placeholder = "Project name";
  name.required = true;

  const repositories = el("textarea");
  repositories.name = "repositories";
  repositories.placeholder = "Repository URLs, one per line";
  repositories.required = true;

  const environment = el(
    "select",
    undefined,
    ...environments.map((option) => {
      const item = el("option", `${option.name} (${option.provider})`);
      item.value = option.id;

      return item;
    }),
  );

  environment.name = "environment";
  environment.setAttribute("aria-label", "Environment");

  const model = el("input");
  model.name = "model";
  model.placeholder = "Coordinator model as provider/id (optional)";

  const instructions = el("textarea");
  instructions.name = "instructions";
  instructions.placeholder = "Project instructions (optional)";

  const submit = el("button", "New Project");
  submit.type = "submit";
  form.append(name, environment, model, repositories, instructions, submit);

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    void context
      .request("projects", {
        name: name.value,
        environment: environment.value,
        repositories: repositories.value.split(/\s+/).filter((url) => url),
        model: model.value,
        instructions: instructions.value,
      })
      .then(async (response) => {
        const body = (await response.json()) as ProjectView | { error: string };
        if ("error" in body) {
          alert(body.error);

          return;
        }

        open(body.id);
      });
  });

  return el(
    "section",
    undefined,
    el("h2", "Projects"),
    list.length === 0 ? el("p", "No Projects yet.") : items,
    el("h3", "New Project"),
    form,
  );
}

async function projectPage(
  context: WebContext,
  view: View,
  back: () => void,
): Promise<HTMLElement> {
  const id = view.project ?? "";
  const response = await context.request(`projects/${encodeURIComponent(id)}`);
  if (!response.ok) {
    return el(
      "section",
      undefined,
      button("All Projects", back),
      el("p", "Project not found."),
    );
  }

  const project = (await response.json()) as ProjectView;

  const environments = (await (
    await fetch("/api/environments")
  ).json()) as Environment[];

  const environmentNames = new Map(
    environments.map(({ id: environmentId, name }) => [environmentId, name]),
  );

  const instructions = el("textarea");
  instructions.value = project.instructions;

  const save = button("Save instructions", () => {
    void context.request(`projects/${encodeURIComponent(id)}/instructions`, {
      instructions: instructions.value,
    });
  });

  const memoryText = el("pre");

  const showMemory = async (name: string): Promise<void> => {
    view.memoryFile = name;

    const reply = await context.request(
      `projects/${encodeURIComponent(id)}/memory/${encodeURIComponent(name)}`,
    );

    memoryText.textContent = reply.ok
      ? ((await reply.json()) as { content: string }).content
      : "";
  };

  if (view.memoryFile !== undefined) {
    await showMemory(view.memoryFile);
  }

  const memory = el(
    "ul",
    undefined,
    ...project.memory.map((file) =>
      el(
        "li",
        undefined,
        button(file.name, () => {
          void showMemory(file.name);
        }),
        document.createTextNode(
          ` ${String(file.size)} bytes, ${file.actor}, ${file.updatedAt}`,
        ),
      ),
    ),
  );

  return el(
    "section",
    undefined,
    button("All Projects", back),
    el("h2", project.name),
    el(
      "p",
      undefined,
      button("Open coordinator", () => {
        context.openSession(project.coordinatorId);
      }),
      document.createTextNode(` ${project.coordinatorState}`),
    ),
    el("p", `Repositories: ${project.repositories.join(", ")}`),
    el("h3", "Threads"),
    project.threads.length === 0
      ? el("p", "No threads yet. Ask the coordinator to start some.")
      : threadTable(context, project.threads, environmentNames),
    el("h3", "Instructions"),
    instructions,
    save,
    el("h3", "Memory"),
    project.memory.length === 0 ? el("p", "Memory is empty.") : memory,
    memoryText,
  );
}

function threadTable(
  context: WebContext,
  threads: readonly ThreadView[],
  environmentNames: ReadonlyMap<string, string>,
): HTMLTableElement {
  const header = el(
    "tr",
    undefined,
    ...["Thread", "Environment", "Run", "Work", "Branch", "Last activity"].map(
      (text) => el("th", text),
    ),
  );

  const rows = threads.map((thread) => {
    const state = el(
      "select",
      undefined,
      ...workStates.map((value) => {
        const option = el("option", value);
        option.value = value;
        option.selected = value === thread.workState;

        return option;
      }),
    );

    state.addEventListener("change", () => {
      void context.request(
        `threads/${encodeURIComponent(thread.sessionId)}/state`,
        { state: state.value },
      );
    });

    const row = el(
      "tr",
      undefined,
      el(
        "td",
        undefined,
        button(thread.title, () => {
          context.openSession(thread.sessionId);
        }),
      ),
      el(
        "td",
        environmentNames.get(thread.environmentId) ?? thread.environmentId,
      ),
      el("td", thread.runState),
      el("td", undefined, state),
      el("td", thread.branch ?? ""),
      el("td", new Date(thread.lastActivity).toLocaleString()),
    );

    if (thread.workState === "blocked" || thread.workState === "review_ready") {
      row.className = "needs-you";
    }

    return row;
  });

  return el("table", undefined, header, ...rows);
}
