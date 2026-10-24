import {
  json,
  type LinkProps,
  type NavItemsProps,
  type NoticeProps,
  ok,
  type PageProps,
  useLoaded,
  useNow,
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
  PageTitle,
  Section,
} from "@pi-cloud/ui";
import {
  type ReactElement,
  type ReactNode,
  type SubmitEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type ProjectNotices,
  type ProjectSummary,
  type ProjectView,
  type ThreadLinkView,
  type RunState,
  type ThreadView,
  type WorkState,
  workStates,
} from "../src/model";

// Thread states change on their own, so an open Project refreshes.
const refreshMs = 3000;

export const projects: WebPlugin = {
  name: "projects",
  nav: { label: "Projects", Page, Items, fills: (path) => path !== "" },
  sessionPath: (session) => `${session.owner?.key ?? ""}/${session.id}`,
  notices: {
    thread: ThreadNotice,
    thread_message: ThreadMessageNotice,
    coordinator_message: CoordinatorMessageNotice,
  },
  links: { thread: ThreadLink },
};

function ThreadLink({ context, target, label }: LinkProps): ReactElement {
  const thread = useLoaded(
    async () =>
      json<ThreadLinkView>(
        context.request(`threads/${encodeURIComponent(target)}`),
      ),
    target,
    refreshMs,
  ).value;

  const group = thread && groupOf(thread);

  return (
    <a
      href={
        thread
          ? context.href(`${thread.projectId}/${thread.sessionId}`)
          : `#${target}`
      }
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-elevated px-2 align-baseline text-label leading-relaxed font-medium text-fg no-underline hover:bg-hover"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          group === undefined && "bg-line",
          thread?.workState === "failed"
            ? "bg-failed"
            : group !== undefined && dots[group],
        )}
      />
      <span className="truncate">{label}</span>
      {thread && (
        <span className="shrink-0 font-normal text-fg-dim">
          {workStateNames[thread.workState]}
        </span>
      )}
    </a>
  );
}

// The server tags each notice it sends with the data its kind draws.
function noticeData<K extends keyof ProjectNotices>(
  { data }: NoticeProps,
  _kind: K,
): ProjectNotices[K] {
  return data as ProjectNotices[K];
}

function ThreadNotice(props: NoticeProps): ReactElement {
  const { threadId, title, event, workState, runState, reply } = noticeData(
    props,
    "thread",
  );

  const line = (
    <>
      <Icon name="chat" className="size-4 shrink-0" />
      <a href={`#${threadId}`} className="truncate font-medium text-fg">
        {title}
      </a>
      <span className="truncate">
        {event} · {workStateNames[workState]}
        {runState === "working" || runState === "idle"
          ? ""
          : ` · ${runBadges[runState]?.label ?? runState}`}
      </span>
    </>
  );

  if (reply === undefined) {
    return (
      <p className="flex min-w-0 items-center gap-2 px-2 py-1 text-label text-fg-dim">
        {line}
      </p>
    );
  }

  return (
    <details className="group px-2 py-1 text-label text-fg-dim">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2">
        {line}
        <Icon
          name="chevron-right"
          className="size-4 shrink-0 group-open:rotate-90"
        />
      </summary>
      <p className="mt-1 ml-6 break-words whitespace-pre-wrap">{reply}</p>
    </details>
  );
}

function ThreadMessageNotice(props: NoticeProps): ReactElement {
  const { threadId, title, text } = noticeData(props, "thread_message");

  return (
    <MessageNotice
      from={
        <a href={`#${threadId}`} className="font-medium text-fg">
          {title}
        </a>
      }
      text={text}
    />
  );
}

function CoordinatorMessageNotice(props: NoticeProps): ReactElement {
  const { text } = noticeData(props, "coordinator_message");

  return <MessageNotice from="Coordinator" text={text} />;
}

function MessageNotice({
  from,
  text,
}: {
  readonly from: ReactNode;
  readonly text: string;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line px-3 py-2 text-label">
      <span className="flex items-center gap-2 text-caption text-fg-dim">
        <Icon name="chat" className="size-3.5 shrink-0" />
        {from}
      </span>
      <p className="break-words whitespace-pre-wrap text-fg">{text}</p>
    </div>
  );
}

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
  const [open = "", ...rest] = path.split("/");

  const go = (to: string): void => {
    location.hash = context.href(to);
  };

  const environments =
    useLoaded(
      async () => json<Environment[]>(fetch("/api/environments")),
      "environments",
    ).value ?? [];

  return open === "" ? (
    <ProjectList context={context} environments={environments} onOpen={go} />
  ) : (
    <ProjectPage
      key={open}
      context={context}
      id={open}
      rest={rest.join("/")}
      environments={environments}
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

function modelNames(environments: readonly Environment[]): string[] {
  return [
    ...new Set(
      environments.flatMap((option) =>
        option.models.map(({ provider, id }) => `${provider}/${id}`),
      ),
    ),
  ];
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
  const models = modelNames(environments);
  const [creating, setCreating] = useState(false);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (creating) {
      return;
    }

    setCreating(true);
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
        setCreating(false);
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
      <Button
        variant="primary"
        type="submit"
        disabled={creating}
        className="justify-self-start"
      >
        New Project
      </Button>
    </form>
  );
}

type Panel =
  | { readonly kind: "none" }
  | { readonly kind: "settings" }
  | { readonly kind: "thread"; readonly id: string; readonly full: boolean };

// "" is the coordinator alone, "settings" its settings beside it, and a
// thread's id opens it beside the coordinator, or fullscreen with "/full".
function panelOf(rest: string, project: ProjectView): Panel {
  const [first = "", second] = rest.split("/");

  if (first === "settings") {
    return { kind: "settings" };
  }

  if (first === "" || first === project.coordinatorId) {
    return { kind: "none" };
  }

  return { kind: "thread", id: first, full: second === "full" };
}

const railKey = "pi-cloud.projects.rail";

function useRail(): readonly [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return (
        matchMedia("(width >= 48rem)").matches &&
        localStorage.getItem(railKey) !== "closed"
      );
    } catch {
      return true;
    }
  });

  return [
    open,
    (next) => {
      setOpen(next);

      try {
        if (matchMedia("(width >= 48rem)").matches) {
          localStorage.setItem(railKey, next ? "open" : "closed");
        }
      } catch {
        // The choice only lasts this visit.
      }
    },
  ];
}

function ProjectPage({
  context,
  id,
  rest,
  environments,
}: {
  readonly context: WebContext;
  readonly id: string;
  readonly rest: string;
  readonly environments: readonly Environment[];
}): ReactElement {
  const path = `projects/${encodeURIComponent(id)}`;
  const [railOpen, setRailOpen] = useRail();
  const { SessionView } = context;

  const { value: project, reload } = useLoaded(
    async () => {
      const response = context.request(path);

      if ((await response).status === 404) {
        return null;
      }

      return json<ProjectView>(response);
    },
    path,
    refreshMs,
  );

  if (project === undefined) {
    return <div className="flex-1" />;
  }

  if (project === null) {
    return (
      <div className="m-auto flex flex-col items-center gap-3 p-8">
        <p className="text-fg-dim">Project not found.</p>
        <a href={context.href("")} className="text-accent hover:underline">
          All Projects
        </a>
      </div>
    );
  }

  const panel = panelOf(rest, project);

  const to = (where: string): string =>
    context.href(where === "" ? id : `${id}/${where}`);

  const go = (where: string): void => {
    location.hash = to(where);
  };

  const thread =
    panel.kind === "thread"
      ? project.threads.find(({ sessionId }) => sessionId === panel.id)
      : undefined;

  const beside = besideOf(panel, railOpen);

  const railToggle = (
    <Button
      variant="ghost"
      iconOnly
      aria-label={beside === undefined ? "Show threads" : "Hide threads"}
      aria-pressed={beside !== undefined}
      onClick={() => {
        setRailOpen(beside === undefined);

        if (beside === "settings" || beside === "thread") {
          go("");
        }
      }}
      className="relative"
    >
      <Icon name="panel-right" />
      {needsYou(project.threads) > 0 && (
        <span className="absolute top-1 right-1 size-2 rounded-full bg-waiting" />
      )}
    </Button>
  );

  const column =
    "flex min-h-0 shrink-0 flex-col border-l border-line max-md:fixed max-md:inset-0 max-md:z-20 max-md:w-full";

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {panel.kind === "thread" && panel.full ? (
          <SessionView
            sessionId={panel.id}
            layout="full"
            {...(thread && { title: thread.title })}
            crumb={
              <>
                <a
                  href={to("")}
                  className="shrink-0 font-normal text-fg-dim hover:text-fg hover:underline"
                >
                  {project.name}
                </a>
                <Icon
                  name="chevron-right"
                  className="size-3.5 shrink-0 text-fg-dim"
                />
              </>
            }
            actions={
              <>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label="Show beside the coordinator"
                  onClick={() => {
                    go(panel.id);
                  }}
                  className="max-md:hidden"
                >
                  <Icon name="minimize" />
                </Button>
                {railToggle}
              </>
            }
          />
        ) : (
          <SessionView
            sessionId={project.coordinatorId}
            layout="full"
            title={project.name}
            actions={
              <>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label="Project settings"
                  aria-pressed={panel.kind === "settings"}
                  onClick={() => {
                    go(panel.kind === "settings" ? "" : "settings");
                  }}
                >
                  <Icon name="settings" />
                </Button>
                {railToggle}
              </>
            }
          />
        )}
      </div>

      {beside === "thread" && panel.kind === "thread" && (
        <aside
          aria-label={thread?.title ?? "Thread"}
          className={cn(column, "w-[min(36rem,50%)] bg-bg")}
        >
          <SessionView
            sessionId={panel.id}
            layout="side"
            {...(thread && { title: thread.title })}
            crumb={
              <Button
                variant="ghost"
                iconOnly
                aria-label="Back to threads"
                onClick={() => {
                  setRailOpen(true);
                  go("");
                }}
                className="-ml-2"
              >
                <Icon name="chevron-right" className="rotate-180" />
              </Button>
            }
            actions={
              <Button
                variant="ghost"
                iconOnly
                aria-label="Open fullscreen"
                onClick={() => {
                  go(`${panel.id}/full`);
                }}
              >
                <Icon name="maximize" />
              </Button>
            }
          />
        </aside>
      )}

      {beside === "settings" && (
        <aside
          aria-label="Project settings"
          className={cn(column, "w-[min(30rem,45%)] bg-bg")}
        >
          <header className="flex min-h-14 items-center gap-2 border-b border-line px-4">
            <h2 className="flex-1 text-title font-semibold text-fg-strong">
              Settings
            </h2>
            <Button
              variant="ghost"
              iconOnly
              aria-label="Close settings"
              onClick={() => {
                go("");
              }}
            >
              <Icon name="x" />
            </Button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
            <ul className="flex flex-col gap-1 font-mono text-mono-sm text-fg-dim">
              {project.repositories.map((repository) => (
                <li key={repository} className="truncate">
                  {repository}
                </li>
              ))}
            </ul>
            <Settings
              context={context}
              path={path}
              project={project}
              onSaved={reload}
              models={modelNames(
                environments.filter(
                  (environment) =>
                    project.environmentId === null ||
                    environment.id === project.environmentId,
                ),
              )}
            />
            <section aria-label="Memory" className="flex flex-col gap-2">
              <h3 className="text-label font-medium text-fg-dim">Memory</h3>
              <Memory context={context} path={path} project={project} />
            </section>
          </div>
        </aside>
      )}

      {beside === "list" && (
        <Rail
          context={context}
          project={project}
          environments={environments}
          current={panel.kind === "thread" ? panel.id : undefined}
          href={to}
          className={cn(column, "w-64 bg-panel")}
          onClose={() => {
            setRailOpen(false);
          }}
        />
      )}
    </div>
  );
}

// The column beside the chat shows the open thread or the settings, or else
// the list of threads while it is open.
function besideOf(
  panel: Panel,
  railOpen: boolean,
): "thread" | "settings" | "list" | undefined {
  if (panel.kind === "settings" || (panel.kind === "thread" && !panel.full)) {
    return panel.kind;
  }

  return railOpen ? "list" : undefined;
}

function needsYou(threads: readonly ThreadView[]): number {
  return threads.filter((thread) => groupOf(thread) === "Needs you").length;
}

type Group = "Needs you" | "Working" | "Review" | "Idle" | "Finished";

const groups: readonly Exclude<Group, "Finished">[] = [
  "Needs you",
  "Working",
  "Review",
  "Idle",
];

function groupOf({ workState, runState }: ThreadView): Group {
  if (workState === "blocked" || runState === "waiting") {
    return "Needs you";
  }

  if (workState === "done" || workState === "failed") {
    return "Finished";
  }

  if (runState === "working") {
    return "Working";
  }

  return workState === "review_ready" ? "Review" : "Idle";
}

const dots: Readonly<Record<Group, string>> = {
  "Needs you": "bg-waiting",
  Working: "bg-working",
  Review: "bg-accent",
  Idle: "border border-fg-dim",
  Finished: "bg-done",
};

function Rail({
  context,
  project,
  environments,
  current,
  href,
  className,
  onClose,
}: {
  readonly context: WebContext;
  readonly project: ProjectView;
  readonly environments: readonly Environment[];
  readonly current: string | undefined;
  readonly href: (where: string) => string;
  readonly className: string;
  readonly onClose: () => void;
}): ReactElement {
  const now = useNow();

  const finished = project.threads.filter(
    (thread) => groupOf(thread) === "Finished",
  );

  const rows = (threads: readonly ThreadView[]): ReactElement => (
    <ul className="flex flex-col gap-0.5">
      {threads.map((thread) => (
        <ThreadRow
          key={thread.sessionId}
          context={context}
          thread={thread}
          current={thread.sessionId === current}
          href={href(thread.sessionId)}
          meta={[
            environments.find(({ id }) => id === thread.environmentId)?.name ??
              thread.environmentId,
            since(thread.lastActivity, now),
          ].join(" · ")}
        />
      ))}
    </ul>
  );

  return (
    <nav aria-label="Threads" className={className}>
      <header className="flex min-h-14 items-center gap-2 border-b border-line pr-2 pl-4">
        <h2 className="flex-1 text-label font-semibold text-fg-strong">
          Threads
        </h2>
        <Button
          variant="ghost"
          iconOnly
          aria-label="Hide threads"
          onClick={onClose}
          className="md:hidden"
        >
          <Icon name="x" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2">
        {project.threads.length === 0 && (
          <p className="px-2 py-1 text-caption text-fg-dim">
            No threads yet. Ask the coordinator to start some.
          </p>
        )}
        {groups.map((group) => {
          const shown = project.threads.filter(
            (thread) => groupOf(thread) === group,
          );

          return shown.length === 0 ? null : (
            <section key={group} aria-label={group}>
              <h3 className="flex items-center gap-2 px-2 pb-1 text-caption font-semibold tracking-wide text-fg-dim uppercase">
                {group} · {shown.length}
              </h3>
              {rows(shown)}
            </section>
          );
        })}
        {finished.length > 0 && (
          <details aria-label="Finished">
            <summary className="cursor-pointer px-2 pb-1 text-caption font-semibold tracking-wide text-fg-dim uppercase">
              Finished ({finished.length})
            </summary>
            {rows(finished)}
          </details>
        )}
      </div>
    </nav>
  );
}

function since(time: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(time)) / 60_000);

  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${String(minutes)}m ago`;
  }

  const hours = Math.floor(minutes / 60);

  return hours < 24
    ? `${String(hours)}h ago`
    : `${String(Math.floor(hours / 24))}d ago`;
}

function ThreadRow({
  context,
  thread,
  current,
  href,
  meta,
}: {
  readonly context: WebContext;
  readonly thread: ThreadView;
  readonly current: boolean;
  readonly href: string;
  readonly meta: string;
}): ReactElement {
  const group = groupOf(thread);

  return (
    <li
      aria-label={thread.title}
      className="group relative flex items-start rounded-md hover:bg-hover has-aria-[current=page]:bg-hover"
    >
      <a
        href={href}
        aria-current={current ? "page" : undefined}
        className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 pr-1 pl-2"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              "size-2 shrink-0 rounded-full",
              thread.workState === "failed" ? "bg-failed" : dots[group],
            )}
          />
          <span
            className={cn(
              "truncate text-label font-medium",
              current ? "text-fg-strong" : "text-fg",
            )}
          >
            {thread.title}
          </span>
        </span>
        <span className="truncate pl-4 text-caption text-fg-dim">
          {thread.runState === "working" || thread.runState === "idle"
            ? meta
            : `${runBadges[thread.runState]?.label ?? thread.runState} · ${meta}`}
        </span>
      </a>
      <ThreadMenu context={context} thread={thread} />
    </li>
  );
}

function ThreadMenu({
  context,
  thread,
}: {
  readonly context: WebContext;
  readonly thread: ThreadView;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const close = (event: Event): void => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : box.current?.contains(event.target as Node) !== true
      ) {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);

    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const run = (request: Promise<Response>): void => {
    setOpen(false);
    setError("");

    ok(request).catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  };

  return (
    <div ref={box} className="relative">
      <Button
        variant="ghost"
        iconOnly
        aria-label={`Actions for ${thread.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
      >
        <Icon name="more" />
      </Button>
      {error !== "" && (
        <p
          role="alert"
          className="absolute top-full right-0 z-30 w-48 rounded-md border border-line bg-elevated p-2 text-caption text-failed shadow-pop"
        >
          {error}
        </p>
      )}
      {open && (
        <div
          role="menu"
          aria-label={`Actions for ${thread.title}`}
          className="absolute top-full right-0 z-30 mt-1 flex min-w-44 flex-col rounded-lg border border-line bg-elevated p-1 shadow-pop"
        >
          {workStates.map((state) => (
            <button
              key={state}
              type="button"
              role="menuitemradio"
              aria-checked={thread.workState === state}
              onClick={() => {
                run(
                  context.request(
                    `threads/${encodeURIComponent(thread.sessionId)}/state`,
                    { state },
                  ),
                );
              }}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-ui text-fg hover:bg-hover"
            >
              <Icon
                name="check"
                className={cn(
                  "size-4",
                  thread.workState !== state && "invisible",
                )}
              />
              {workStateNames[state]}
            </button>
          ))}
          <hr className="my-1 border-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              run(
                fetch(
                  `/api/sessions/${encodeURIComponent(thread.sessionId)}/archive`,
                  { method: "POST" },
                ),
              );
            }}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-ui text-fg hover:bg-hover"
          >
            <Icon name="archive" className="size-4" />
            Archive
          </button>
        </div>
      )}
    </div>
  );
}

const workStateNames: Readonly<Record<WorkState, string>> = {
  in_progress: "In progress",
  blocked: "Blocked",
  review_ready: "Ready for review",
  done: "Done",
  failed: "Failed",
};

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

function Settings({
  context,
  path,
  project,
  onSaved,
  models,
}: {
  readonly context: WebContext;
  readonly path: string;
  readonly project: ProjectView;
  readonly onSaved: () => void;
  readonly models: readonly string[];
}): ReactElement {
  const saved = {
    name: project.name,
    threadModel: project.threadModel ?? "",
    instructions: project.instructions,
  };

  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const changed = (Object.keys(saved) as (keyof typeof saved)[]).some(
    (key) => draft[key] !== saved[key],
  );

  const edit =
    (key: keyof typeof saved) =>
    (event: { readonly target: { readonly value: string } }): void => {
      setDraft({ ...draft, [key]: event.target.value });
    };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        setSaving(true);

        ok(context.request(`${path}/settings`, draft))
          .then(onSaved, (failure: unknown) => {
            setError(
              failure instanceof Error ? failure.message : String(failure),
            );
          })
          .finally(() => {
            setSaving(false);
          });
      }}
      className="grid max-w-xl gap-3"
    >
      <Field label="Name">
        <input
          required
          value={draft.name}
          onChange={edit("name")}
          className={fieldClass}
        />
      </Field>
      <Field label="Thread model">
        <input
          list="project-settings-models"
          placeholder="The coordinator's model"
          value={draft.threadModel}
          onChange={edit("threadModel")}
          className={cn(fieldClass, "font-mono text-mono-sm")}
        />
      </Field>
      <datalist id="project-settings-models">
        {models.map((ref) => (
          <option key={ref} value={ref} />
        ))}
      </datalist>
      <Field label="Instructions">
        <textarea
          rows={4}
          value={draft.instructions}
          onChange={edit("instructions")}
          className={fieldClass}
        />
      </Field>
      <p className="text-caption text-fg-dim">
        New threads use these. The coordinator&apos;s model is in its own model
        menu.
      </p>
      <Button
        type="submit"
        disabled={!changed || saving}
        className="justify-self-start"
      >
        Save settings
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
  const open = project.memory.find(({ name }) => name === shown);
  const version = open ? `${open.name} ${open.updatedAt}` : "";

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
  }, version).value;

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
