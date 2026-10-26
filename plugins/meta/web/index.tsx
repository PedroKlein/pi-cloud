import {
  type HomeProps,
  json,
  type NavItemsProps,
  type PageProps,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pi-cloud/plugins/web";
import type { Environment, ModelRef, Session } from "@pi-cloud/protocol";
import { Button, cn, Icon, isComposing } from "@pi-cloud/ui";
import {
  type ReactElement,
  type SubmitEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

// Fired when a new meta-session starts, so every list shows it at once.
const started = new EventTarget();

const modelKey = "pi-cloud.meta.model";

export const meta: WebPlugin = {
  name: "meta",
  nav: { label: "Assistant", Page, Items, fills: (path) => path !== "" },
  sessionPath: (session) => session.id,
  Home,
};

function useMetaSessions(
  context: WebContext,
  load = async (): Promise<Session[]> =>
    json<Session[]>(context.request("sessions")),
): readonly Session[] {
  const { value, reload } = useLoaded(load, "sessions", {
    topics: ["sessions"],
  });

  useEffect(() => {
    started.addEventListener("started", reload);

    return () => {
      started.removeEventListener("started", reload);
    };
  }, [reload]);

  return value ?? [];
}

function titleOf(session: Session): string {
  return session.title ?? session.firstMessage ?? "Untitled";
}

function Home({ context, onNewSession }: HomeProps): ReactElement {
  const environments = useLoaded(
    async () => json<Environment[]>(fetch("/api/environments")),
    "environments",
  ).value;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-12 md:py-24">
      <h1 className="text-center text-display font-semibold text-fg-strong">
        What do you want to build today?
      </h1>
      {environments !== undefined && environments.length > 0 && (
        <Composer context={context} models={modelNames(environments)} />
      )}
      <div className="flex justify-center">
        <Button variant="ghost" onClick={onNewSession}>
          <Icon name="plus" />
          Start a session yourself
        </Button>
      </div>
      <Recent context={context} />
    </div>
  );
}

// The list is only extra on the home screen, so a failed load leaves it out
// instead of taking the composer down with it.
function Recent({ context }: { readonly context: WebContext }): ReactElement {
  const sessions = useMetaSessions(context, async () =>
    json<Session[]>(context.request("sessions")).catch(() => []),
  );

  if (sessions.length === 0) {
    return <></>;
  }

  return (
    <section aria-labelledby="recent-meta" className="flex flex-col gap-2">
      <h2 id="recent-meta" className="text-label font-medium text-fg-dim">
        Earlier conversations
      </h2>
      <ul className="flex flex-col gap-0.5">
        {sessions.slice(0, 8).map((session) => (
          <li key={session.id}>
            <a
              href={context.href(session.id)}
              className="block truncate rounded-md px-3 py-2 text-fg hover:bg-hover"
            >
              {titleOf(session)}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Composer({
  context,
  models,
}: {
  readonly context: WebContext;
  readonly models: readonly string[];
}): ReactElement {
  const textId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [model, setModel] = useState(remembered);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const send = (): void => {
    if (text.trim() === "" || sending) {
      return;
    }

    setSending(true);
    setError(undefined);

    const ref = modelRef(model);

    json<Session>(
      context.request("sessions", { text, ...(ref && { model: ref }) }),
    ).then(
      (session) => {
        started.dispatchEvent(new Event("started"));
        location.hash = context.href(session.id);
      },
      (reason: unknown) => {
        setSending(false);
        setError(reason instanceof Error ? reason.message : String(reason));
        textRef.current?.focus();
      },
    );
  };

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    send();
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2 rounded-xl border border-line bg-elevated py-2 pr-2 pl-4 shadow-card focus-within:border-accent"
    >
      <label htmlFor={textId} className="sr-only">
        Ask the Pi Cloud assistant
      </label>
      <textarea
        id={textId}
        ref={textRef}
        rows={3}
        value={text}
        readOnly={sending}
        aria-busy={sending}
        placeholder="Set up a Project for my repositories, start a Session that fixes the failing tests…"
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          const forced = event.metaKey || event.ctrlKey;

          if (
            isComposing(event) ||
            event.key !== "Enter" ||
            event.shiftKey ||
            (!forced && matchMedia("(pointer: coarse)").matches)
          ) {
            return;
          }

          event.preventDefault();
          send();
        }}
        className="resize-none bg-transparent pt-1 text-prose text-fg placeholder:text-fg-dim focus:outline-none"
      />
      <div className="flex items-center gap-2">
        {error === undefined ? (
          <span className="flex-1 truncate text-caption text-fg-dim pointer-coarse:hidden">
            Enter sends · the assistant asks before anything risky
          </span>
        ) : (
          <p role="alert" className="flex-1 text-caption text-failed">
            {error}
          </p>
        )}
        <select
          aria-label="Model"
          value={model}
          onChange={(event) => {
            setModel(event.target.value);
            remember(event.target.value);
          }}
          className="h-7 max-w-48 field-sizing-content cursor-pointer truncate rounded-md bg-transparent px-1.5 text-caption text-fg-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          <option value="">Default model</option>
          {[...new Set([model, ...models])]
            .filter((name) => name !== "")
            .map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
        </select>
        <Button
          variant="primary"
          iconOnly
          type="submit"
          aria-label="Send"
          disabled={sending}
          className="ml-auto rounded-full"
        >
          <Icon name="arrow-up" />
        </Button>
      </div>
    </form>
  );
}

function Items({ context, path }: NavItemsProps): ReactElement {
  const sessions = useMetaSessions(context);

  return (
    <ul className="flex flex-col gap-0.5">
      {sessions.slice(0, 5).map((session) => (
        <li key={session.id}>
          <a
            href={context.href(session.id)}
            aria-current={path === session.id ? "page" : undefined}
            className="block truncate rounded-md py-1.5 pr-2 pl-10.5 text-label text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
          >
            {titleOf(session)}
          </a>
        </li>
      ))}
    </ul>
  );
}

function Page({ context, path }: PageProps): ReactElement {
  if (path === "") {
    return <Conversations context={context} />;
  }

  return (
    <context.SessionView
      sessionId={path}
      layout="full"
      crumb={
        <a href={context.href("")} className="text-fg-dim hover:text-fg">
          Assistant
        </a>
      }
    />
  );
}

function Conversations({
  context,
}: {
  readonly context: WebContext;
}): ReactElement {
  const sessions = useMetaSessions(context);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-display font-semibold text-fg-strong">Assistant</h1>
      {sessions.length === 0 ? (
        <p className="text-fg-dim">
          Conversations with the Pi Cloud assistant show here.{" "}
          <a href="#" className="text-accent">
            Start one
          </a>
          .
        </p>
      ) : (
        <ul className={cn("flex flex-col gap-0.5")}>
          {sessions.map((session) => (
            <li key={session.id}>
              <a
                href={context.href(session.id)}
                className="block truncate rounded-md px-3 py-2 text-fg hover:bg-hover"
              >
                {titleOf(session)}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function modelNames(environments: readonly Environment[]): string[] {
  return [
    ...new Set(
      environments.flatMap(({ models }) =>
        models.map(({ provider, id }) => `${provider}/${id}`),
      ),
    ),
  ];
}

function modelRef(name: string): ModelRef | undefined {
  const slash = name.indexOf("/");

  return slash > 0 && slash < name.length - 1
    ? { provider: name.slice(0, slash), id: name.slice(slash + 1) }
    : undefined;
}

// The model the user last asked the assistant with, on this browser only.
function remembered(): string {
  try {
    return localStorage.getItem(modelKey) ?? "";
  } catch {
    return "";
  }
}

function remember(model: string): void {
  try {
    localStorage.setItem(modelKey, model);
  } catch {
    // The choice only lasts this visit.
  }
}
