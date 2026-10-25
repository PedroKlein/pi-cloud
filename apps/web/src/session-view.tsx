import {
  type Environment,
  type OpenedPage,
  piTerminal,
  previewPort,
  type Session,
  type TerminalTab,
  terminalTakenOver,
} from "@pi-cloud/protocol";
import type { EmbeddedSessionProps } from "@pi-cloud/plugins/web";
import { Badge, Button, cn, Icon, type IconName } from "@pi-cloud/ui";
import {
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, command } from "./api";
import { Composer } from "./composer";
import { ChatView } from "./chat-view";
import { emptyFeed, type Feed, feedReader, followEvents } from "./feed";
import { describe, sessionBadge, shortName, workspaceName } from "./names";
import { PluginBoundary } from "./plugin-boundary";
import { PrimaryView, usePrimaryId } from "./primary";
import { enabledPlugins, pluginContext } from "./plugins";
import { sessionChannel } from "./session-channel";
import { keyBar, type Modifier, modified } from "./keys";
import { openTerminal } from "./terminal";

type View = "chat" | "pi" | "terminal";

export function SessionView({
  sessionId,
  environments,
  onSessionChange,
  onMenu,
  layout = "full",
  title: shownTitle,
  crumb,
  actions,
}: {
  readonly sessionId: string;
  readonly environments: readonly Environment[];
  readonly onSessionChange?: () => void;
  readonly onMenu?: () => void;
} & Omit<EmbeddedSessionProps, "sessionId" | "layout"> &
  Partial<Pick<EmbeddedSessionProps, "layout">>): ReactElement {
  const primary = layout === "full";
  const [feed, setFeed] = useState<Feed>(emptyFeed);
  const [view, setView] = useState<View>("chat");
  const report = useRef<(error: unknown) => void>(() => undefined);
  const [channel] = useState(() => sessionChannel(sessionId));

  const sessionChanged = useEffectEvent(() => {
    onSessionChange?.();
  });

  const reportError = useCallback((error: unknown) => {
    report.current(error);
  }, []);

  useEffect(() => {
    const reader = feedReader({
      dispatch: channel.dispatch,
      onChange: setFeed,
      onSession: () => {
        sessionChanged();
      },
    });

    report.current = reader.report;

    return followEvents(sessionId, reader, (url) => new EventSource(url));
  }, [sessionId, channel]);

  const { session } = feed;

  const place = session ? shortName(session.workspace) : "";
  const named = feed.title ?? session?.title ?? undefined;
  const title = shownTitle ?? named ?? place;

  const archived = session !== undefined && session.archivedAt !== null;
  const shown = archived ? "chat" : view;

  const pageTitle = shownTitle ?? named;

  useEffect(() => {
    if (!primary) {
      return undefined;
    }

    document.title =
      pageTitle === undefined ? "Pi Cloud" : `${pageTitle} · Pi Cloud`;

    return () => {
      document.title = "Pi Cloud";
    };
  }, [pageTitle, primary]);

  // Kept across renders so plugin parts re-render on their own events, not on
  // every token.
  const pluginHeaders = useMemo(
    () =>
      enabledPlugins().map(({ name, SessionHeader }) =>
        SessionHeader ? (
          <span key={name} data-plugin={name}>
            <PluginBoundary name={name}>
              <SessionHeader
                context={pluginContext(name)}
                session={channel.session}
              />
            </PluginBoundary>
          </span>
        ) : null,
      ),
    [channel.session],
  );

  const pluginPanels = useMemo(
    () =>
      enabledPlugins().map(({ name, SessionPanel }) =>
        SessionPanel ? (
          <div key={name} data-plugin={name} className="empty:hidden">
            <PluginBoundary name={name}>
              <SessionPanel
                context={pluginContext(name)}
                session={channel.session}
              />
            </PluginBoundary>
          </div>
        ) : null,
      ),
    [channel.session],
  );

  // The fork starts from this Session's branch, so it gets what was pushed
  // or, on the same machine, committed.
  const forkSession = async (id: string): Promise<void> => {
    try {
      const response = await api(
        `/api/sessions/${encodeURIComponent(id)}/fork`,
        {},
      );

      location.hash = ((await response.json()) as Session).id;
    } catch (error) {
      reportError(error);
    }
  };

  const action = (name: string): void => {
    api(`/api/sessions/${encodeURIComponent(sessionId)}/${name}`, {}).catch(
      reportError,
    );
  };

  return (
    <PrimaryView value={primary}>
      <section
        id={primary ? "session" : undefined}
        aria-label={title}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <header
          className={cn(
            "flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2",
            shown !== "chat" && "bg-term-bg",
          )}
        >
          {onMenu && (
            <Button
              variant="ghost"
              iconOnly
              aria-label="Open sessions"
              onClick={onMenu}
              className="md:hidden"
            >
              <Icon name="menu" />
            </Button>
          )}
          <div
            className={cn(
              "flex min-w-0 flex-col",
              primary ? "flex-[1_1_240px]" : "flex-[1_1_160px]",
            )}
          >
            <h1 className="flex min-w-0 items-center gap-1.5 text-title font-semibold text-fg-strong">
              {crumb}
              <span className="truncate">{title}</span>
            </h1>
            <p className="flex min-w-0 items-center gap-2 text-caption text-fg-dim">
              <span className="truncate font-mono">
                {session ? sessionCrumb(session, environments) : ""}
              </span>
              <span aria-hidden="true">·</span>
              <span id={primary ? "status" : undefined} className="shrink-0">
                {statusText(feed)}
              </span>
            </p>
          </div>
          {session && <StateBadge session={session} />}
          <span
            id={primary ? "plugin-header" : undefined}
            className="flex items-center gap-2 text-caption text-fg-dim"
          >
            {pluginHeaders}
          </span>
          {!archived && <ViewSwitch view={view} onChange={setView} />}
          {actions}
          {session && (
            <SessionMenu
              items={[
                archived
                  ? {
                      label: "Unarchive",
                      icon: "archive",
                      run: () => {
                        action("unarchive");
                      },
                    }
                  : {
                      label: "Archive",
                      icon: "archive",
                      run: () => {
                        action("archive");
                      },
                    },
                {
                  label: "Fork",
                  icon: "git-fork",
                  run: () => {
                    void forkSession(sessionId);
                  },
                },
                ...(session.workspaceRemoval === "kept"
                  ? [
                      {
                        label: "Delete workspace",
                        icon: "trash",
                        danger: true,
                        run: () => {
                          if (
                            confirm(
                              `The workspace was kept: ${session.workspaceKeptReason ?? "unpushed work"}. Delete it for good?`,
                            )
                          ) {
                            action("remove-workspace");
                          }
                        },
                      } as const,
                    ]
                  : []),
              ]}
            />
          )}
        </header>

        <div
          id={primary ? "plugin-panels" : undefined}
          className="flex flex-col gap-2 border-b border-line px-4 py-2 text-label not-has-[>:not(:empty)]:hidden"
        >
          {pluginPanels}
        </div>

        {shown === "terminal" && (
          <TerminalView sessionId={sessionId} terminals={feed.terminals} />
        )}
        {shown === "pi" && (
          <TerminalScreen
            sessionId={sessionId}
            terminalId={piTerminal}
            onClosed={() => {
              setView("chat");
            }}
          />
        )}
        <div
          hidden={shown !== "chat"}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <ChatView
            feed={feed}
            place={place}
            hidden={shown !== "chat"}
            session={channel.session}
          />
          {!archived && (
            <PagesNotice
              sessionId={sessionId}
              pages={feed.pages}
              report={reportError}
            />
          )}
          <UiActionNotice
            uiAction={archived ? undefined : feed.uiAction}
            goes={primary && shown === "chat"}
          />
          {!archived && (
            <PiViewNotice
              piView={feed.piView}
              onOpen={() => {
                setView("pi");
              }}
            />
          )}
          <Composer
            sessionId={sessionId}
            session={channel.session}
            feed={feed}
            models={
              environments.find(({ id }) => id === session?.environmentId)
                ?.models ?? []
            }
            hidden={archived}
            report={reportError}
          />
        </div>
      </section>
    </PrimaryView>
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

interface MenuItem {
  readonly label: string;
  readonly icon: IconName;
  readonly danger?: boolean;
  readonly run: () => void;
}

function SessionMenu({
  items,
}: {
  readonly items: readonly MenuItem[];
}): ReactElement {
  const [open, setOpen] = useState(false);
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

  return (
    <div ref={box} className="relative">
      <Button
        variant="ghost"
        iconOnly
        aria-label="Session actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="more" />
      </Button>
      {open && (
        <div
          role="menu"
          aria-label="Session actions"
          className="absolute top-full right-0 z-30 mt-1 flex min-w-48 flex-col rounded-lg border border-line bg-elevated p-1 shadow-pop"
        >
          {items.map(({ label, icon, danger, run }) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                run();
              }}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-ui hover:bg-hover",
                danger === true ? "text-failed" : "text-fg",
              )}
            >
              <Icon name={icon} className="size-4" />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ViewSwitch({
  view,
  onChange,
}: {
  readonly view: View;
  readonly onChange: (view: View) => void;
}): ReactElement {
  const option = (value: View, label: string, icon: IconName): ReactElement => (
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
      {option("pi", "Pi", "monitor")}
      {option("terminal", "Terminal", "terminal")}
    </div>
  );
}

// While a browser shows Pi's TUI, extension dialogs open there (ADR 0027).
// What the Session asked to open in a browser, such as plannotator's review.
// A page on the Session's own machine opens through a preview (ADR 0037).
function PagesNotice({
  sessionId,
  pages,
  report,
}: {
  readonly sessionId: string;
  readonly pages: readonly OpenedPage[];
  readonly report: (error: unknown) => void;
}): ReactElement | null {
  if (pages.length === 0) {
    return null;
  }

  return (
    <ul
      aria-label="Opened pages"
      className="mx-auto flex w-full max-w-chat flex-col gap-1 px-4 pb-2 text-label text-fg-dim"
    >
      {pages.map((page) => (
        <li key={page.id} className="flex items-center gap-3">
          <Icon name="external-link" />
          <span className="min-w-0 flex-1 truncate font-mono">
            {page.url.replace(/^https?:\/\//, "")}
          </span>
          <a
            href={pageLink(sessionId, page.url)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-control items-center rounded-md border border-line bg-elevated px-3 text-ui font-medium text-fg hover:border-line-strong hover:bg-hover pointer-coarse:min-h-touch"
          >
            Open
          </a>
          <Button
            variant="ghost"
            iconOnly
            aria-label="Dismiss"
            onClick={() => {
              command(sessionId, { type: "close_page", id: page.id }).catch(
                report,
              );
            }}
          >
            <Icon name="x" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

// What a meta-session's tool opened (ADR 0035). A wide screen goes there at
// once; a phone offers it instead, so the chat stays where it is.
// What a meta-session's tool opened (ADR 0035). The main chat on a wide
// screen goes there at once; anywhere else it is offered instead, so the
// chat stays where it is. The region stays mounted so readers announce it.
function UiActionNotice({
  uiAction,
  goes,
}: {
  readonly uiAction: Feed["uiAction"];
  readonly goes: boolean;
}): ReactElement {
  const [dismissed, setDismissed] = useState<number>();
  const handled = useRef<number>(undefined);
  const wide = goes && matchMedia("(width >= 48rem)").matches;

  useEffect(() => {
    if (uiAction === undefined || handled.current === uiAction.key) {
      return;
    }

    handled.current = uiAction.key;

    if (goes && matchMedia("(width >= 48rem)").matches) {
      location.hash = `#${uiAction.action.route}`;
    }
  }, [uiAction, goes]);

  const offered =
    uiAction !== undefined && !wide && uiAction.key !== dismissed
      ? uiAction.action
      : undefined;

  return (
    <div role="status" className="mx-auto w-full max-w-chat px-4">
      {offered && (
        <div className="flex items-center gap-3 pb-2 text-label text-fg-dim">
          <Icon name="chevron-right" />
          <span className="min-w-0 flex-1 truncate">Open {offered.label}?</span>
          <a
            href={`#${offered.route}`}
            className="inline-flex h-control items-center rounded-md border border-line bg-elevated px-3 text-ui font-medium text-fg hover:border-line-strong hover:bg-hover pointer-coarse:min-h-touch"
          >
            Open
          </a>
          <Button
            variant="ghost"
            iconOnly
            aria-label="Dismiss"
            onClick={() => {
              setDismissed(uiAction?.key);
            }}
          >
            <Icon name="x" />
          </Button>
        </div>
      )}
    </div>
  );
}

function pageLink(sessionId: string, url: string): string {
  const port = previewPort(url);
  if (port === undefined) {
    return url;
  }

  const { pathname, search, hash } = new URL(url);
  const path = encodeURIComponent(`${pathname}${search}${hash}`);

  return `/api/sessions/${encodeURIComponent(sessionId)}/previews/${String(port)}?path=${path}`;
}

function PiViewNotice({
  piView: { attached, dialog },
  onOpen,
}: {
  readonly piView: Feed["piView"];
  readonly onOpen: () => void;
}): ReactElement | null {
  if (!attached && dialog === null) {
    return null;
  }

  return (
    <p
      role="status"
      className="mx-auto flex w-full max-w-chat items-center gap-3 px-4 pb-2 text-label text-fg-dim"
    >
      <span className="min-w-0 flex-1">
        {dialog === null
          ? "Pi is open in a Pi view, so extension dialogs show there."
          : `Pi is asking in the Pi view: ${dialog}`}
      </span>
      <Button variant="ghost" onClick={onOpen}>
        Open Pi view
      </Button>
    </p>
  );
}

function TerminalView({
  sessionId,
  terminals,
}: {
  readonly sessionId: string;
  readonly terminals: readonly TerminalTab[];
}): ReactElement {
  const end = useRef<() => void>(() => undefined);

  const [active, setActive] = useState(
    () => terminals[0]?.id ?? crypto.randomUUID(),
  );

  const [closed, setClosed] = useState<string>();
  const [failures, setFailures] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [listed, setListed] = useState<string>();

  const shown = terminals.some(({ id }) => id === active);
  if (shown && listed !== active) {
    setListed(active);
  }

  // A listed terminal that drops out of the list has exited.
  const exited = listed === active && !shown;

  const reopen = useEffectEvent(() => {
    setClosed(undefined);
    if (exited) {
      setActive(terminals[0]?.id ?? crypto.randomUUID());
    } else {
      setGeneration(generation + 1);
    }
  });

  useEffect(() => {
    if (closed !== active) {
      return undefined;
    }

    const timer = setTimeout(
      () => {
        reopen();
      },
      exited ? 0 : Math.min(1000 * 2 ** failures, 30_000),
    );

    return () => {
      clearTimeout(timer);
    };
  }, [closed, active, exited, failures]);

  const tabs = shown
    ? terminals
    : [...terminals, { id: active, label: "New terminal" }];

  return (
    <>
      <div
        role="tablist"
        aria-label="Terminals"
        className="flex items-center gap-1 overflow-x-auto border-b border-line bg-term-bg px-2 pt-1.5"
      >
        {tabs.map(({ id, label }) => (
          <span
            key={id}
            className="group/tab flex shrink-0 items-center rounded-t-md text-label text-fg-dim has-aria-selected:bg-panel has-aria-selected:text-fg-strong"
          >
            <button
              type="button"
              role="tab"
              aria-selected={id === active}
              onClick={() => {
                setActive(id);
              }}
              className="cursor-pointer py-1.5 pl-3 font-mono"
            >
              {label}
            </button>
            <button
              type="button"
              aria-label={`Close ${label}`}
              onClick={() => {
                if (id === active) {
                  end.current();
                }

                setActive(
                  terminals.find((other) => other.id !== id)?.id ??
                    crypto.randomUUID(),
                );
              }}
              className="invisible cursor-pointer px-2 py-1.5 group-has-aria-selected/tab:visible"
            >
              <Icon name="x" className="size-3.5" />
            </button>
          </span>
        ))}
        <Button
          variant="ghost"
          iconOnly
          aria-label="New terminal"
          onClick={() => {
            setActive(crypto.randomUUID());
          }}
          className="h-7 w-7"
        >
          <Icon name="plus" className="size-4" />
        </Button>
      </div>
      <TerminalScreen
        key={generation}
        sessionId={sessionId}
        terminalId={active}
        endRef={end}
        onClosed={(reason, opened) => {
          if (reason !== terminalTakenOver) {
            setFailures(opened ? 0 : failures + 1);
            setClosed(active);
          }
        }}
      />
    </>
  );
}

function TerminalScreen({
  sessionId,
  terminalId,
  endRef,
  onClosed,
}: {
  readonly sessionId: string;
  readonly terminalId: string;
  readonly endRef?: RefObject<() => void>;
  // The shell or Pi's TUI ended, or the socket dropped.
  readonly onClosed?: (reason: string, opened: boolean) => void;
}): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const elementId = usePrimaryId("terminal");
  const send = useRef<(data: string) => void>(() => undefined);
  const [modifier, setModifier] = useState<Modifier>();

  const typed = useEffectEvent((data: string): string => {
    setModifier(undefined);

    return modified(data, modifier);
  });

  const closed = useEffectEvent((reason: string, opened: boolean) => {
    onClosed?.(reason, opened);
  });

  useEffect(() => {
    if (!box.current) {
      return undefined;
    }

    const terminal = openTerminal(
      sessionId,
      terminalId,
      box.current,
      (data) => typed(data),
      (reason, opened) => {
        closed(reason, opened);
      },
    );

    send.current = terminal.send;

    if (endRef) {
      endRef.current = terminal.end;
    }

    return terminal.close;
  }, [sessionId, terminalId, endRef]);

  const keys: readonly {
    readonly label: string;
    readonly data?: string;
    readonly modifier?: Modifier;
  }[] = [
    ...keyBar.slice(0, 2),
    { label: "Ctrl", modifier: "ctrl" },
    { label: "Alt", modifier: "alt" },
    ...keyBar.slice(2),
  ];

  return (
    <>
      <div className="min-h-0 flex-1 bg-term-bg px-3 py-2">
        <div id={elementId} ref={box} className="h-full" />
      </div>
      <div
        role="toolbar"
        aria-label="Terminal keys"
        className="hidden gap-2 overflow-x-auto border-t border-line bg-panel px-2 py-2 max-md:flex pointer-coarse:flex"
      >
        {keys.map((key) => (
          <button
            key={key.label}
            type="button"
            aria-pressed={
              key.modifier === undefined ? undefined : modifier === key.modifier
            }
            // Keeps the focus, and with it the phone keyboard, on the terminal.
            onPointerDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              if (key.modifier === undefined) {
                send.current(modified(key.data ?? "", modifier));
                setModifier(undefined);
              } else {
                setModifier(
                  modifier === key.modifier ? undefined : key.modifier,
                );
              }
            }}
            className="h-10 min-w-12 shrink-0 cursor-pointer rounded-md border border-line bg-elevated px-3 font-mono text-label text-fg aria-pressed:border-accent aria-pressed:bg-accent-tint"
          >
            {key.label}
          </button>
        ))}
      </div>
    </>
  );
}
