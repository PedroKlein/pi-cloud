import type { Environment, Session } from "@pi-cloud/protocol";
import { Badge, Button, cn, Icon } from "@pi-cloud/ui";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import { Composer } from "./composer";
import { ChatView } from "./chat-view";
import { emptyFeed, type Feed, follow } from "./feed";
import { describe, sessionBadge, shortName, workspaceName } from "./names";
import { enabledPlugins, pluginContext, sessionChannel } from "./plugins";
import { openTerminal } from "./terminal";

type View = "chat" | "terminal";

export function SessionView({
  sessionId,
  environments,
  onSessionChange,
  onMenu,
}: {
  readonly sessionId: string;
  readonly environments: readonly Environment[];
  readonly onSessionChange: () => void;
  readonly onMenu: () => void;
}): ReactElement {
  const [feed, setFeed] = useState<Feed>(emptyFeed);
  const [view, setView] = useState<View>("chat");
  const report = useRef<(error: unknown) => void>(() => undefined);
  const [channel] = useState(() => sessionChannel(sessionId));
  const sessionChanged = useEffectEvent(onSessionChange);

  const reportError = useCallback((error: unknown) => {
    report.current(error);
  }, []);

  useEffect(() => {
    const feedStream = follow(sessionId, {
      dispatch: channel.dispatch,
      onChange: setFeed,
      onSession: () => {
        sessionChanged();
      },
    });

    report.current = feedStream.report;

    return () => {
      feedStream.close();
    };
  }, [sessionId, channel]);

  const { session } = feed;

  const place = session ? shortName(session.workspace) : "";
  const title = feed.title ?? place;

  const archived = session !== undefined && session.archivedAt !== null;

  useEffect(() => {
    document.title =
      feed.title === undefined ? "Pi Cloud" : `${feed.title} · Pi Cloud`;
  }, [feed.title]);

  const action = (name: string): void => {
    api(`/api/sessions/${encodeURIComponent(sessionId)}/${name}`, {}).catch(
      reportError,
    );
  };

  return (
    <section
      id="session"
      aria-label={title}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header
        className={cn(
          "flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2",
          view === "terminal" && "bg-term-bg",
        )}
      >
        <Button
          variant="ghost"
          iconOnly
          aria-label="Open sessions"
          onClick={onMenu}
          className="md:hidden"
        >
          <Icon name="menu" />
        </Button>
        <div className="flex min-w-0 flex-[1_1_240px] flex-col">
          <h1 className="truncate text-title font-semibold text-fg-strong">
            {title}
          </h1>
          <p className="flex min-w-0 items-center gap-2 text-caption text-fg-dim">
            <span className="truncate font-mono">
              {session ? sessionCrumb(session, environments) : ""}
            </span>
            <span aria-hidden="true">·</span>
            <span id="status" className="shrink-0">
              {statusText(feed)}
            </span>
          </p>
        </div>
        {session && <StateBadge session={session} />}
        <span
          id="plugin-header"
          className="flex items-center gap-2 text-caption text-fg-dim"
        >
          {enabledPlugins().map(({ name, SessionHeader }) =>
            SessionHeader ? (
              <span key={name} data-plugin={name}>
                <SessionHeader
                  context={pluginContext(name)}
                  session={channel.session}
                />
              </span>
            ) : null,
          )}
        </span>
        {!archived && <ViewSwitch view={view} onChange={setView} />}
        <div className="flex gap-1">
          {session && !archived && (
            <Button
              variant="ghost"
              onClick={() => {
                action("archive");
              }}
            >
              <Icon name="archive" />
              Archive
            </Button>
          )}
          {archived && (
            <Button
              variant="ghost"
              onClick={() => {
                action("unarchive");
              }}
            >
              <Icon name="archive" />
              Unarchive
            </Button>
          )}
          {session?.workspaceRemoval === "kept" && (
            <Button
              variant="danger"
              onClick={() => {
                if (
                  confirm(
                    "Delete this workspace and its unpushed work for good?",
                  )
                ) {
                  action("remove-workspace");
                }
              }}
            >
              <Icon name="trash" />
              Delete workspace
            </Button>
          )}
        </div>
      </header>

      <div
        id="plugin-panels"
        className="flex flex-col gap-2 border-b border-line px-4 py-2 text-label not-has-[>:not(:empty)]:hidden"
      >
        {enabledPlugins().map(({ name, SessionPanel }) =>
          SessionPanel ? (
            <div key={name} data-plugin={name} className="empty:hidden">
              <SessionPanel
                context={pluginContext(name)}
                session={channel.session}
              />
            </div>
          ) : null,
        )}
      </div>

      {view === "terminal" && !archived ? (
        <TerminalView sessionId={sessionId} />
      ) : (
        <>
          <ChatView feed={feed} place={place} />
          <Composer
            sessionId={sessionId}
            feed={feed}
            hidden={archived}
            report={reportError}
          />
        </>
      )}
    </section>
  );
}

function statusText({ missing, session }: Feed): string {
  if (missing) {
    return "session not found";
  }

  return session ? describe(session) : "";
}

function sessionCrumb(
  session: Session,
  environments: readonly Environment[],
): string {
  return [
    environments.find((e) => e.id === session.environmentId)?.name ??
      session.provider,
    workspaceName(session.workspace),
  ].join(" · ");
}

function StateBadge({
  session,
}: {
  readonly session: Session;
}): ReactElement | null {
  const badge = sessionBadge(session);

  return badge ? <Badge state={badge.state}>{badge.label}</Badge> : null;
}

function ViewSwitch({
  view,
  onChange,
}: {
  readonly view: View;
  readonly onChange: (view: View) => void;
}): ReactElement {
  const option = (
    value: View,
    label: string,
    icon: "chat" | "terminal",
  ): ReactElement => (
    <button
      type="button"
      aria-pressed={view === value}
      onClick={() => {
        onChange(value);
      }}
      className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full px-3 text-label font-medium text-fg-dim aria-pressed:bg-accent-tint aria-pressed:text-fg-strong pointer-coarse:h-9"
    >
      <Icon
        name={icon}
        className={cn("size-3.5", view === value && "text-accent")}
      />
      <span className="max-sm:sr-only">{label}</span>
    </button>
  );

  return (
    <div
      role="group"
      aria-label="View"
      className="inline-flex gap-0.5 rounded-full border border-line bg-panel p-0.5"
    >
      {option("chat", "Chat", "chat")}
      {option("terminal", "Terminal", "terminal")}
    </div>
  );
}

function TerminalView({
  sessionId,
}: {
  readonly sessionId: string;
}): ReactElement {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!box.current) {
      return undefined;
    }

    return openTerminal(sessionId, box.current, () => undefined);
  }, [sessionId]);

  return (
    <div className="min-h-0 flex-1 bg-term-bg px-3 py-2">
      <div id="terminal" ref={box} className="h-full" />
    </div>
  );
}
