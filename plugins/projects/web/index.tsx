import {
  json,
  type PageProps,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pi-cloud/plugins/web";
import type { Environment } from "@pi-cloud/protocol";
import {
  Badge,
  type BadgeState,
  Button,
  cn,
  fieldClass,
  Icon,
  PageTitle,
  Section,
} from "@pi-cloud/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import {
  type ProjectSummary,
  type ProjectView,
  type RunState,
  type ThreadView,
  type WorkState,
  workStates,
} from "../src/model";

// Thread states change on their own, so an open Project refreshes.
const refreshMs = 3000;

export const projects: WebPlugin = {
  name: "projects",
  nav: { label: "Projects", Page },
};

function Page({ context }: PageProps): ReactElement {
  const [open, setOpen] = useState<string>();

  const environments =
    useLoaded(
      async () => json<Environment[]>(fetch("/api/environments")),
      "environments",
    ).value ?? [];

  return open === undefined ? (
    <ProjectList
      context={context}
      environments={environments}
      onOpen={setOpen}
    />
  ) : (
    <ProjectPage
      key={open}
      context={context}
      id={open}
      environments={environments}
      onBack={() => {
        setOpen(undefined);
      }}
    />
  );
}

function ProjectList({
  context,
  environments,
  onOpen,
}: {
  readonly context: WebContext;
  readonly environments: readonly Environment[];
  readonly onOpen: (id: string) => void;
}): ReactElement {
  const list = useLoaded(
    async () => json<ProjectSummary[]>(context.request("projects")),
    "projects",
  ).value;

  return (
    <>
      <PageTitle description="A Project is a coordinator session that starts threads across one or more repositories.">
        Projects
      </PageTitle>
      {list?.length === 0 && <p className="text-fg-dim">No Projects yet.</p>}
      <ul className="grid gap-2 sm:grid-cols-2">
        {list?.map((project) => (
          <li key={project.id}>
            <button
              type="button"
              onClick={() => {
                onOpen(project.id);
              }}
              className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-line bg-panel px-4 py-3 text-left hover:border-line-strong hover:bg-hover"
            >
              <span className="font-medium text-fg-strong">{project.name}</span>
              <span className="text-caption text-fg-dim">
                {project.threads} {project.threads === 1 ? "thread" : "threads"}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Section title="New Project">
        <CreateForm
          context={context}
          environments={environments}
          onCreated={onOpen}
        />
      </Section>
    </>
  );
}

function CreateForm({
  context,
  environments,
  onCreated,
}: {
  readonly context: WebContext;
  readonly environments: readonly Environment[];
  readonly onCreated: (id: string) => void;
}): ReactElement {
  const models = [
    ...new Set(
      environments.flatMap((option) =>
        option.models.map(({ provider, id }) => `${provider}/${id}`),
      ),
    ),
  ];

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);

    const field = (name: string): string => {
      const value = data.get(name);

      return typeof value === "string" ? value : "";
    };

    json<ProjectView>(
      context.request("projects", {
        name: field("name"),
        environment: field("environment"),
        repositories: field("repositories")
          .split(/\s+/)
          .filter((url) => url),
        model: field("model"),
        threadModel: field("threadModel"),
        instructions: field("instructions"),
      }),
    ).then(
      (project) => {
        onCreated(project.id);
      },
      (error: unknown) => {
        alert(error instanceof Error ? error.message : String(error));
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      className="project-create grid max-w-xl gap-3 rounded-lg border border-line bg-panel p-5"
    >
      <input
        name="name"
        placeholder="Project name"
        aria-label="Project name"
        required
        className={fieldClass}
      />
      <select
        name="environment"
        aria-label="Environment"
        className={fieldClass}
      >
        {environments.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name} ({option.provider})
          </option>
        ))}
      </select>
      <input
        name="model"
        list="project-models"
        aria-label="Coordinator model"
        placeholder="Coordinator model as provider/id (optional)"
        className={fieldClass}
      />
      <input
        name="threadModel"
        list="project-models"
        aria-label="Thread model"
        placeholder="Thread model as provider/id (optional)"
        className={fieldClass}
      />
      <datalist id="project-models">
        {models.map((ref) => (
          <option key={ref} value={ref} />
        ))}
      </datalist>
      <textarea
        name="repositories"
        aria-label="Repositories"
        placeholder="Repository URLs, one per line"
        required
        rows={2}
        className={fieldClass}
      />
      <textarea
        name="instructions"
        aria-label="Instructions"
        placeholder="Project instructions (optional)"
        rows={3}
        className={fieldClass}
      />
      <Button variant="primary" type="submit" className="justify-self-start">
        New Project
      </Button>
    </form>
  );
}

function ProjectPage({
  context,
  id,
  environments,
  onBack,
}: {
  readonly context: WebContext;
  readonly id: string;
  readonly environments: readonly Environment[];
  readonly onBack: () => void;
}): ReactElement {
  const path = `projects/${encodeURIComponent(id)}`;

  const project = useLoaded(
    async () => {
      const response = await context.request(path);

      return response.ok ? ((await response.json()) as ProjectView) : null;
    },
    path,
    refreshMs,
  ).value;

  const back = (
    <Button variant="ghost" onClick={onBack} className="-ml-3 mb-2 self-start">
      <Icon name="chevron-right" className="rotate-180" />
      All Projects
    </Button>
  );

  if (project === undefined) {
    return back;
  }

  if (project === null) {
    return (
      <>
        {back}
        <p className="text-fg-dim">Project not found.</p>
      </>
    );
  }

  return (
    <>
      {back}
      <PageTitle
        description={`Repositories: ${project.repositories.join(", ")}`}
      >
        {project.name}
      </PageTitle>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          onClick={() => {
            context.openSession(project.coordinatorId);
          }}
        >
          Open coordinator
        </Button>
        <RunBadge state={project.coordinatorState} />
      </div>

      <Section title="Threads">
        {project.threads.length === 0 ? (
          <p className="text-fg-dim">
            No threads yet. Ask the coordinator to start some.
          </p>
        ) : (
          <ThreadTable
            context={context}
            threads={project.threads}
            environments={environments}
          />
        )}
      </Section>

      <Section title="Instructions">
        <Instructions
          context={context}
          path={path}
          saved={project.instructions}
        />
      </Section>

      <Section title="Memory">
        <Memory context={context} path={path} project={project} />
      </Section>
    </>
  );
}

const runBadges: Readonly<
  Record<RunState, { state: BadgeState; label: string } | undefined>
> = {
  working: { state: "working", label: "Working" },
  idle: undefined,
  offline: { state: "offline", label: "Offline" },
  interrupted: { state: "offline", label: "Interrupted" },
  archived: { state: "offline", label: "Archived" },
};

function RunBadge({ state }: { readonly state: RunState }): ReactElement {
  const badge = runBadges[state];

  return badge ? (
    <Badge state={badge.state}>{badge.label}</Badge>
  ) : (
    <span className="text-label text-fg-dim">{state}</span>
  );
}

const needsYou: readonly WorkState[] = ["blocked", "review_ready"];

function ThreadTable({
  context,
  threads,
  environments,
}: {
  readonly context: WebContext;
  readonly threads: readonly ThreadView[];
  readonly environments: readonly Environment[];
}): ReactElement {
  const cell = "border-b border-line px-3 py-2.5 text-left";

  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-ui [&_tr:last-child>td]:border-b-0">
        <thead className="bg-panel text-label text-fg-dim">
          <tr>
            {[
              "Thread",
              "Environment",
              "Run",
              "Work",
              "Branch",
              "Last activity",
            ].map((heading) => (
              <th key={heading} className={cn(cell, "font-medium")}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {threads.map((thread) => (
            <tr
              key={thread.sessionId}
              className={cn(
                needsYou.includes(thread.workState) && "bg-waiting-tint",
              )}
            >
              <td className={cell}>
                <button
                  type="button"
                  onClick={() => {
                    context.openSession(thread.sessionId);
                  }}
                  className="cursor-pointer font-medium text-accent hover:underline"
                >
                  {thread.title}
                </button>
              </td>
              <td className={cell}>
                {environments.find(({ id }) => id === thread.environmentId)
                  ?.name ?? thread.environmentId}
              </td>
              <td className={cell}>
                <RunBadge state={thread.runState} />
              </td>
              <td className={cell}>
                <select
                  key={thread.workState}
                  aria-label={`Work state of ${thread.title}`}
                  defaultValue={thread.workState}
                  onChange={(event) => {
                    void context.request(
                      `threads/${encodeURIComponent(thread.sessionId)}/state`,
                      { state: event.target.value },
                    );
                  }}
                  className={cn(fieldClass, "py-1")}
                >
                  {workStates.map((value) => (
                    <option key={value} value={value}>
                      {value.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </td>
              <td className={cn(cell, "font-mono text-mono-sm")}>
                {thread.branch ?? ""}
              </td>
              <td className={cn(cell, "text-label text-fg-dim")}>
                {new Date(thread.lastActivity).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Instructions({
  context,
  path,
  saved,
}: {
  readonly context: WebContext;
  readonly path: string;
  readonly saved: string;
}): ReactElement {
  const [draft, setDraft] = useState(saved);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void context.request(`${path}/instructions`, { instructions: draft });
      }}
      className="flex flex-col gap-3"
    >
      <textarea
        aria-label="Project instructions"
        rows={4}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        className={fieldClass}
      />
      <Button type="submit" disabled={draft === saved} className="self-start">
        Save instructions
      </Button>
    </form>
  );
}

function Memory({
  context,
  path,
  project,
}: {
  readonly context: WebContext;
  readonly path: string;
  readonly project: ProjectView;
}): ReactElement {
  const [shown, setShown] = useState<string>();

  const content = useLoaded(async () => {
    if (shown === undefined) {
      return "";
    }

    const reply = await context.request(
      `${path}/memory/${encodeURIComponent(shown)}`,
    );

    return reply.ok
      ? ((await reply.json()) as { content: string }).content
      : "";
  }, shown ?? "").value;

  if (project.memory.length === 0) {
    return <p className="text-fg-dim">Memory is empty.</p>;
  }

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,16rem)_1fr]">
      <ul className="flex flex-col gap-0.5">
        {project.memory.map((file) => (
          <li key={file.name}>
            <button
              type="button"
              aria-current={file.name === shown ? "true" : undefined}
              onClick={() => {
                setShown(file.name);
              }}
              className="flex w-full cursor-pointer flex-col rounded-md px-3 py-1.5 text-left hover:bg-hover aria-[current=true]:bg-hover"
            >
              <span className="font-mono text-mono-sm text-fg">
                {file.name}
              </span>
              <span className="text-caption text-fg-dim">
                {file.size} bytes · {file.actor}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {shown !== undefined && (
        <pre className="max-h-[60vh] overflow-auto rounded-md border border-line bg-code px-3 py-2 font-mono text-mono-sm whitespace-pre-wrap">
          {content}
        </pre>
      )}
    </div>
  );
}
