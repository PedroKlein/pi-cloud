import type { WebContext, WebPlugin } from "@pi-cloud/plugins/web";
import type { LibraryFile, LibraryWrite } from "../src/model";

interface ProjectSummary {
  readonly id: string;
  readonly name: string;
}

export const library: WebPlugin = {
  name: "library",
  nav: {
    label: "Library",
    mount: (element, context) => {
      let project: string | undefined;

      const render = async (): Promise<void> => {
        element.replaceChildren(
          await page(context, project, (id) => {
            project = id;
            void render();
          }),
        );
      };

      void render();

      return () => undefined;
    },
  },
};

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

async function page(
  context: WebContext,
  selected: string | undefined,
  select: (id: string) => void,
): Promise<HTMLElement> {
  const projects = (await (
    await fetch("/api/plugins/projects/projects")
  ).json()) as ProjectSummary[];

  if (projects.length === 0) {
    return el(
      "section",
      undefined,
      el("h2", "Library"),
      el("p", "Create a Project first."),
    );
  }

  const id = selected ?? projects[0]?.id ?? "";
  const base = `projects/${encodeURIComponent(id)}`;

  const picker = el(
    "select",
    undefined,
    ...projects.map((project) => {
      const option = el("option", project.name);
      option.value = project.id;
      option.selected = project.id === id;

      return option;
    }),
  );

  picker.setAttribute("aria-label", "Project");

  picker.addEventListener("change", () => {
    select(picker.value);
  });

  const files = (await (
    await context.request(`${base}/files`)
  ).json()) as LibraryFile[];

  const writes = (await (
    await context.request(`${base}/log`)
  ).json()) as LibraryWrite[];

  const upload = el("input");
  upload.type = "file";
  upload.multiple = true;
  upload.setAttribute("aria-label", "Upload files");

  upload.addEventListener("change", () => {
    void Promise.all(
      [...(upload.files ?? [])].map(async (file) =>
        fetch(
          `/api/plugins/library/${base}/files/${encodeURIComponent(file.name)}`,
          {
            method: "PUT",
            body: file,
          },
        ).then(async (response) => {
          if (!response.ok) {
            alert(((await response.json()) as { error: string }).error);
          }
        }),
      ),
    ).then(() => {
      select(id);
    });
  });

  const list = el(
    "ul",
    undefined,
    ...files.map((file) => {
      const link = el("a", file.name);
      link.href = `/api/plugins/library/${base}/files/${encodeURIComponent(file.name)}`;
      link.download = file.name;

      return el(
        "li",
        undefined,
        link,
        document.createTextNode(
          ` ${String(file.size)} bytes, ${file.actor}, ${file.updatedAt}`,
        ),
      );
    }),
  );

  return el(
    "section",
    undefined,
    el("h2", "Library"),
    picker,
    el("h3", "Files"),
    files.length === 0 ? el("p", "No files yet.") : list,
    el("label", "Upload ", upload),
    el("h3", "Recent writes"),
    el(
      "ul",
      undefined,
      ...writes.map((write) =>
        el(
          "li",
          `${write.at} ${write.actor} wrote ${write.name} (${String(write.size)} bytes)`,
        ),
      ),
    ),
  );
}
