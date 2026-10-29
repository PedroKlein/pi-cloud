import {
  json,
  ok,
  type PageProps,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pipoca/plugins/web";
import { FileButton, PageTitle, Section, Select } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import type { LibraryFile, LibraryWrite } from "../src/model";

interface ProjectSummary {
  readonly id: string;
  readonly name: string;
}

export const library: WebPlugin = {
  name: "library",
  nav: { label: "Library", Page },
};

function Page({ context }: PageProps): ReactElement {
  const [selected, setSelected] = useState<string>();

  const projects = useLoaded(
    async () =>
      json<ProjectSummary[]>(context.request("/api/plugins/projects/projects")),
    "projects",
  ).value;

  if (!projects) {
    return <PageTitle>Library</PageTitle>;
  }

  const id = selected ?? projects[0]?.id;

  return (
    <>
      <PageTitle description="Files every session in a Project can read and write.">
        Library
      </PageTitle>
      {id === undefined ? (
        <p className="text-fg-dim">Create a Project first.</p>
      ) : (
        <>
          <Select
            aria-label="Project"
            value={id}
            onChange={(event) => {
              setSelected(event.target.value);
            }}
            className="self-start"
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
          <ProjectFiles key={id} context={context} projectId={id} />
        </>
      )}
    </>
  );
}

function ProjectFiles({
  context,
  projectId,
}: {
  readonly context: WebContext;
  readonly projectId: string;
}): ReactElement {
  const base = `projects/${encodeURIComponent(projectId)}`;

  const { value, reload } = useLoaded(
    async () =>
      Promise.all([
        json<LibraryFile[]>(context.request(`${base}/files`)),
        json<LibraryWrite[]>(context.request(`${base}/log`)),
      ]),
    base,
  );

  const [files, writes] = value ?? [[], []];

  const filePath = (name: string): string =>
    `${base}/files/${encodeURIComponent(name)}`;

  const upload = async (chosen: readonly File[]): Promise<void> => {
    const results = await Promise.allSettled(
      chosen.map(async (file) =>
        ok(context.request(filePath(file.name), { method: "PUT", body: file })),
      ),
    );

    reload();

    const failures = results.flatMap((result) =>
      result.status === "rejected"
        ? [
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
          ]
        : [],
    );

    if (failures.length > 0) {
      alert(failures.join("\n"));
    }
  };

  return (
    <>
      <Section title="Files">
        {files.length === 0 ? (
          <p className="text-fg-dim">No files yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {files.map((file) => (
              <li
                key={file.name}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5"
              >
                <a
                  href={`/api/plugins/library/${filePath(file.name)}`}
                  download={file.name}
                  className="font-mono text-mono text-accent hover:underline"
                >
                  {file.name}
                </a>
                <span className="text-caption text-fg-dim">
                  {file.size} bytes · {file.actor} ·{" "}
                  {new Date(file.updatedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
        <FileButton
          multiple
          aria-label="Upload files"
          className="self-start"
          onFiles={(picked) => {
            void upload(picked);
          }}
        >
          Upload files
        </FileButton>
      </Section>
      <Section title="Recent writes">
        {writes.length === 0 ? (
          <p className="text-fg-dim">Nothing written yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-label">
            {writes.map((write, index) => (
              <li key={`${String(index)}-${write.at}`}>
                <span className="text-fg-dim">
                  {new Date(write.at).toLocaleString()}
                </span>{" "}
                {write.actor} wrote {write.name} ({write.size} bytes)
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
