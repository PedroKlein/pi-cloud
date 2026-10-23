import {
  json,
  type NavItemsProps,
  ok,
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
  Field,
  fieldClass,
  Icon,
  isComposing,
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
  nav: { label: "Projects", Page, Items },
};

function Items({ context, path }: NavItemsProps): ReactElement {
  const list = useLoaded(
    async () => json<ProjectSummary[]>(context.request("projects")),
    "projects",
    refreshMs,
  ).value;

  return (
    <ul id="project-nav" className="flex flex-col gap-0.5">
      {list
        ?.filter((project) => project.coordinatorState !== "archived")
        .map((project) => (
          <li key={project.id}>
            <a
              href={context.href(project.id)}
              aria-current={path === project.id ? "page" : undefined}
              className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5 rounded-md py-1.5 pr-2 pl-10.5 text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
            >
              <span className="truncate text-label font-medium">
                {project.name}
              </span>
              {project.needsYou > 0 ? (
                <Badge state="waiting">{project.needsYou} needs you</Badge>
              ) : (
                <span />
              )}
              <span className="col-span-2 truncate text-caption text-fg-dim">
                {counted(project.repositories, "repository", "repositories")} ·
                coordinator {project.coordinatorState}
              </span>
            </a>
          </li>
        ))}
    </ul>
  );
}

function counted(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function Page({ context, path }: PageProps): ReactElement {
  const open = path === "" ? undefined : path;

  const go = (to: string): void => {
    location.hash = context.href(to);
  };

  const environments =
    useLoaded(
      async () => json<Environment[]>(fetch("/api/environments")),
      "environments",
    ).value ?? [];

  return open === undefined ? (
    <ProjectList context={context} environments={environments} onOpen={go} />
  ) : (
    <ProjectPage
      key={open}
      context={context}
      id={open}
      environments={environments}
      onBack={() => {
        go("");
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
      <Field label="Name">
        <input name="name" required className={fieldClass} />
      </Field>
      <Field label="Environment">
        <select name="environment" className={fieldClass}>
          {environments.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name} ({option.provider})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Coordinator model">
        <input
          name="model"
          list="project-models"
          placeholder="Environment default"
          className={cn(fieldClass, "font-mono text-mono-sm")}
        />
      </Field>
      <Field label="Thread model">
        <input
          name="threadModel"
          list="project-models"
          placeholder="Environment default"
          className={cn(fieldClass, "font-mono text-mono-sm")}
        />
      </Field>
      <datalist id="project-models">
        {models.map((ref) => (
          <option key={ref} value={ref} />
        ))}
      </datalist>
      <Field label="Repository URLs, one per line">
        <textarea
          name="repositories"
          required
          rows={2}
          className={fieldClass}
        />
      </Field>
      <Field label="Instructions">
        <textarea
          name="instructions"
          placeholder="Optional"
          rows={3}
          className={fieldClass}
        />
      </Field>
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
      <PageTitle description={project.repositories.join(" · ")}>
        {project.name}
      </PageTitle>

      <Coordinator context={context} path={path} project={project} />

      <Section title="Threads">
        {project.threads.length === 0 ? (
          <p className="text-fg-dim">
            No threads yet. Ask the coordinator to start some.
          </p>
        ) : (
          <ThreadBoard
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

function Coordinator({
  context,
  path,
  project,
}: {
  readonly context: WebContext;
  readonly path: string;
  readonly project: ProjectView;
}): ReactElement {
  const [error, setError] = useState("");

  const send = (form: HTMLFormElement): void => {
    const box = form.elements.namedItem("text");
    if (!(box instanceof HTMLTextAreaElement) || box.value.trim() === "") {
      return;
    }

    const text = box.value;
    box.value = "";
    setError("");

    context.request(`${path}/message`, { text }).then(
      async (response) => {
        if (!response.ok) {
          box.value = text;

          const { error: reason } = (await response.json()) as {
            error: string;
          };

          setError(reason);
        }
      },
      (failure: unknown) => {
        box.value = text;
        setError(String(failure));
      },
    );
  };

  return (
    <section
      aria-label="Coordinator"
      className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4"
    >
      <header className="flex items-center gap-3">
        <h2 className="flex-1 text-label font-medium text-fg-dim">
          Coordinator
        </h2>
        <RunBadge state={project.coordinatorState} />
        <Button
          variant="ghost"
          onClick={() => {
            context.openSession(project.coordinatorId);
          }}
        >
          Open coordinator
        </Button>
      </header>
      <p className="text-prose whitespace-pre-wrap text-fg">
        {project.coordinatorSays ?? "No reply yet."}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          send(event.currentTarget);
        }}
        className="flex items-end gap-2 rounded-lg border border-line bg-bg py-2 pr-2 pl-3 focus-within:border-accent"
      >
        <textarea
          name="text"
          rows={2}
          aria-label="Message the coordinator"
          placeholder="Ask the coordinator or start new work"
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !isComposing(event)
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          className="flex-1 resize-none bg-transparent text-ui text-fg placeholder:text-fg-dim focus:outline-none"
        />
        <Button
          variant="primary"
          iconOnly
          type="submit"
          aria-label="Send to the coordinator"
          className="rounded-full"
        >
          <Icon name="arrow-up" />
        </Button>
      </form>
      {error !== "" && (
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      )}
    </section>
  );
}

const runBadges: Readonly<
  Record<RunState, { state: BadgeState; label: string } | undefined>
> = {
  working: { state: "working", label: "Working" },
  waiting: { state: "waiting", label: "Needs you" },
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

const columns: readonly {
  readonly label: string;
  readonly states: readonly WorkState[];
  readonly dot: string;
}[] = [
  {
    label: "Needs you",
    states: ["blocked", "review_ready"],
    dot: "bg-waiting",
  },
  { label: "Working", states: ["in_progress"], dot: "bg-working" },
  { label: "Failed", states: ["failed"], dot: "bg-failed" },
  { label: "Done", states: ["done"], dot: "bg-done" },
];

function ThreadBoard({
  context,
  threads,
  environments,
}: {
  readonly context: WebContext;
  readonly threads: readonly ThreadView[];
  readonly environments: readonly Environment[];
}): ReactElement {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {columns.map(({ label, states, dot }, index) => {
        const shown = threads.filter((thread) =>
          index === 0
            ? states.includes(thread.workState) || thread.runState === "waiting"
            : states.includes(thread.workState) &&
              thread.runState !== "waiting",
        );

        return (
          <section
            key={label}
            aria-label={label}
            className="flex min-w-0 flex-col gap-2"
          >
            <h3 className="flex items-center gap-2 text-label text-fg-dim">
              <span className={cn("size-2 rounded-full", dot)} />
              {label} · {shown.length}
            </h3>
            {shown.map((thread) => (
              <ThreadCard
                key={thread.sessionId}
                context={context}
                thread={thread}
                needsYou={index === 0}
                environment={
                  environments.find(({ id }) => id === thread.environmentId)
                    ?.name ?? thread.environmentId
                }
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function ThreadCard({
  context,
  thread,
  needsYou,
  environment,
}: {
  readonly context: WebContext;
  readonly thread: ThreadView;
  readonly needsYou: boolean;
  readonly environment: string;
}): ReactElement {
  const [error, setError] = useState("");
  const [failures, setFailures] = useState(0);

  return (
    <article
      aria-label={thread.title}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-panel p-3",
        needsYou ? "border-waiting" : "border-line",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => {
            context.openSession(thread.sessionId);
          }}
          className="cursor-pointer text-left font-medium text-fg-strong hover:underline"
        >
          {thread.title}
        </button>
        {thread.runState !== "idle" && <RunBadge state={thread.runState} />}
      </div>
      <p className="truncate text-caption text-fg-dim">
        {[
          environment,
          thread.branch,
          new Date(thread.lastActivity).toLocaleString(undefined, {
            dateStyle: "short",
            timeStyle: "short",
          }),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <select
        key={`${thread.workState} ${String(failures)}`}
        aria-label={`Work state of ${thread.title}`}
        defaultValue={thread.workState}
        onChange={(event) => {
          setError("");

          ok(
            context.request(
              `threads/${encodeURIComponent(thread.sessionId)}/state`,
              { state: event.target.value },
            ),
          ).catch((failure: unknown) => {
            setError(
              failure instanceof Error ? failure.message : String(failure),
            );

            setFailures((count) => count + 1);
          });
        }}
        className={cn(fieldClass, "self-start py-0.5 text-label")}
      >
        {workStates.map((value) => (
          <option key={value} value={value}>
            {value.replace("_", " ")}
          </option>
        ))}
      </select>
      {error !== "" && (
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      )}
    </article>
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
  const [error, setError] = useState("");

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError("");

        ok(
          context.request(`${path}/instructions`, { instructions: draft }),
        ).catch((failure: unknown) => {
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        });
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
      {error !== "" && (
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      )}
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
