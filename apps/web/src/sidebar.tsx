import { ThemeSwitch } from "./theme";
import { availability, type Environment, type Session } from "@pipoca/protocol";
import { Badge, Button, cn, fieldClass, Icon } from "@pipoca/ui";
import { type ReactElement, useEffect, useState } from "react";
import { json, useNow } from "@pipoca/plugins/web";
import { api, send } from "./api";
import { Mark } from "./mark";
import { matches } from "./notices";
import {
  ago,
  modelName,
  sessionBadge,
  shortName,
  workspaceName,
} from "./names";
import { PluginBoundary } from "./plugin-boundary";
import { isSettingsRoute } from "./settings-layout";
import {
  enabledPlugins,
  type NavEntry,
  pluginContext,
  pluginRoute,
  sessionHref,
} from "./plugins";

export interface SidebarProps {
  readonly nav: readonly NavEntry[];
  readonly route: string;
  readonly sessions: readonly Session[];
  readonly environments: readonly Environment[];
  readonly showArchived: boolean;
  readonly onShowArchived: (show: boolean) => void;
  readonly onNewSession: () => void;
  readonly user: string;
}

export function Sidebar({
  nav,
  route,
  sessions,
  environments,
  showArchived,
  onShowArchived,
  onNewSession,
  user,
}: SidebarProps): ReactElement {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const environmentName = (session: Session): string =>
    environments.find((e) => e.id === session.environmentId)?.name ??
    session.provider;

  // A plugin's own Sessions show inside the plugin, and here only in a search
  // or once the plugin is off (ADR 0028).
  const shown = sessions.filter(
    (session) =>
      (query !== "" || !ownedByEnabled(session)) &&
      matches(session, query, environmentName(session)),
  );

  return (
    <nav aria-label="Pipoca" className="flex h-full flex-col bg-panel">
      <div className="flex items-center justify-between gap-2 py-3 pr-3 pl-4">
        <span className="flex items-center gap-2 font-serif text-wordmark font-light text-fg-strong">
          <Mark className="size-7" />
          pipoca
        </span>
        <span className="flex items-center gap-1">
          <Button
            variant="ghost"
            iconOnly
            aria-label="Search"
            aria-expanded={searching}
            onClick={() => {
              setSearching(!searching);
              setQuery("");
            }}
          >
            <Icon name="search" />
          </Button>
          <Button
            variant="primary"
            iconOnly
            aria-label="New session"
            onClick={onNewSession}
          >
            <Icon name="plus" />
          </Button>
        </span>
      </div>

      <PluginNav nav={nav} route={route} />

      <div className="mt-2 flex items-center justify-between border-t border-line px-4 pt-4 pb-2">
        <h2 className="text-caption font-medium text-fg-dim">Sessions</h2>
        <label className="flex cursor-pointer items-center gap-1.5 text-caption text-fg-dim">
          <input
            id="show-archived"
            type="checkbox"
            checked={showArchived}
            onChange={(event) => {
              onShowArchived(event.target.checked);
            }}
            className="accent-accent"
          />
          Show archived
        </label>
      </div>

      {searching && (
        <div className="px-3 pb-2">
          <input
            type="search"
            aria-label="Search sessions"
            placeholder="Search sessions"
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearching(false);
                setQuery("");
              }
            }}
            className={cn(fieldClass, "w-full py-1 text-label")}
          />
        </div>
      )}

      <ul
        id="sessions"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2"
      >
        {shown.length === 0 && (
          <li className="px-3 py-2 text-caption text-fg-dim">
            {query === "" ? "No sessions yet." : "No sessions match."}
          </li>
        )}
        {shown.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            environment={environments.find(
              (e) => e.id === session.environmentId,
            )}
            current={session.id === route}
          />
        ))}
      </ul>

      <NotifyButton />
      <EnvironmentStatus environments={environments} />
      <AccountMenu user={user} current={isSettingsRoute(route)} />
    </nav>
  );
}

function ownedByEnabled({ owner }: Session): boolean {
  return (
    owner !== null && enabledPlugins().some(({ name }) => name === owner.plugin)
  );
}

function SessionRow({
  session,
  environment,
  current,
}: {
  readonly session: Session;
  readonly environment: Environment | undefined;
  readonly current: boolean;
}): ReactElement {
  const badge = sessionBadge(session);
  const now = useNow();

  const meta = [
    ...(session.owner === null ? [] : [ownerLabel(session.owner.plugin)]),
    ...(session.title === null ? [] : [shortName(session.workspace)]),
    environment?.name ?? session.provider,
    ...(session.model ? [modelName(session.model)] : []),
    session.archivedAt === null ? ago(session.createdAt, now) : "archived",
  ].join(" · ");

  return (
    <li data-id={session.id}>
      <a
        href={sessionHref(session)}
        aria-current={current ? "page" : undefined}
        className="relative grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5 rounded-md px-3 py-2 text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:before:absolute aria-[current=page]:before:inset-y-2 aria-[current=page]:before:left-0 aria-[current=page]:before:w-0.5 aria-[current=page]:before:rounded-full aria-[current=page]:before:bg-accent"
      >
        <span
          title={workspaceName(session.workspace)}
          className={cn(
            "truncate text-ui font-medium",
            current && "text-fg-strong",
          )}
        >
          {session.title ?? shortName(session.workspace)}
        </span>
        {badge ? <Badge state={badge.state}>{badge.label}</Badge> : <span />}
        <span className="col-span-2 truncate text-caption text-fg-dim">
          {meta}
        </span>
      </a>
    </li>
  );
}

function ownerLabel(plugin: string): string {
  const label =
    enabledPlugins().find(({ name }) => name === plugin)?.nav?.label ??
    plugin.charAt(0).toUpperCase() + plugin.slice(1);

  return `from ${label}`;
}

function EnvironmentStatus({
  environments,
}: {
  readonly environments: readonly Environment[];
}): ReactElement {
  return (
    <div className="flex items-start gap-2 border-t border-line py-2.5 pr-2 pl-4">
      <ul className="flex flex-1 flex-wrap gap-x-4 gap-y-1 pt-1 text-caption text-fg-dim">
        {environments.map((environment) => (
          <li key={environment.id} className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-2 rounded-full",
                availability(environment) === "Offline"
                  ? "border border-fg-dim"
                  : "bg-done",
              )}
            />
            {environment.name}{" "}
            {availability(environment) === "Starts runners on demand"
              ? "on demand"
              : availability(environment).toLowerCase()}
          </li>
        ))}
      </ul>
      <ThemeSwitch />
    </div>
  );
}

function NotifyButton(): ReactElement | null {
  const [permission, setPermission] = useState(() =>
    typeof Notification === "undefined" ? "denied" : Notification.permission,
  );

  if (permission !== "default") {
    return null;
  }

  return (
    <div className="border-t border-line px-2 py-2">
      <Button
        variant="ghost"
        onClick={() => {
          void Notification.requestPermission().then(setPermission);
        }}
        className="w-full justify-start text-label"
      >
        <Icon name="bell" />
        Notify me when sessions finish
      </Button>
    </div>
  );
}

// Settings and signing out, behind the user's name like Claude Code's account
// menu (ADR 0040).
function AccountMenu({
  user,
  current,
}: {
  readonly user: string;
  readonly current: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="relative border-t border-line px-2 py-2"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
        }
      }}
    >
      {open && (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-2 bottom-full left-2 mb-1 flex flex-col rounded-lg border border-line bg-elevated p-1 shadow-pop"
        >
          <a
            role="menuitem"
            href="#settings"
            onClick={() => {
              setOpen(false);
            }}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-ui text-fg hover:bg-hover"
          >
            <Icon name="settings" />
            Settings
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void api("/api/auth/logout", {}).finally(() => {
                location.replace("/");
              });
            }}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui text-fg hover:bg-hover"
          >
            Sign out
          </button>
        </div>
      )}
      <Button
        variant="ghost"
        aria-label="Account"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={current ? "page" : undefined}
        onClick={() => {
          setOpen(!open);
        }}
        className="w-full justify-start text-label aria-[current=page]:bg-hover"
      >
        <span
          aria-hidden="true"
          className="grid size-6 place-items-center rounded-full bg-accent-tint text-caption font-semibold text-accent uppercase"
        >
          {user.slice(0, 1)}
        </span>
        <span className="flex-1 truncate text-left">{user}</span>
        <Icon name="settings" className="text-fg-dim" />
      </Button>
    </div>
  );
}

// Plugin pages show in the sidebar when pinned, and the rest under More, like
// Claude Code's sidebar (ADR 0040).
const pinnedAtFirst = ["projects", "meta"];

function PluginNav({
  nav,
  route,
}: {
  readonly nav: readonly NavEntry[];
  readonly route: string;
}): ReactElement | null {
  const [pins, setPins] = useState<readonly string[]>();
  const [more, setMore] = useState(false);
  const page = pluginRoute(route);

  useEffect(() => {
    void json<{ readonly pages: string[] | null }>(fetch("/api/pinned-pages"))
      .then(({ pages }) => {
        setPins(pages ?? pinnedAtFirst);
      })
      .catch(() => {
        setPins(pinnedAtFirst);
      });
  }, []);

  if (nav.length === 0 || pins === undefined) {
    return null;
  }

  const pin = (name: string, pinned: boolean): void => {
    const next = pinned
      ? [...pins, name]
      : pins.filter((known) => known !== name);

    setPins(next);
    void send("/api/pinned-pages", "PUT", { pages: next });
  };

  const pinned = nav.filter(({ name }) => pins.includes(name));
  const rest = nav.filter(({ name }) => !pins.includes(name));
  const showRest = more || rest.some(({ name }) => page?.name === name);

  const row = (entry: NavEntry, isPinned: boolean): ReactElement => (
    <div key={entry.name} className="flex flex-col gap-0.5">
      <div className="group/row relative">
        <a
          href={`#plugin/${entry.name}`}
          aria-current={route === `plugin/${entry.name}` ? "page" : undefined}
          className="group/nav flex items-center gap-2.5 rounded-md px-2 py-1.5 text-ui text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
        >
          <span
            aria-hidden="true"
            className="grid size-6 place-items-center rounded-md border border-line bg-elevated text-caption font-semibold text-fg-dim uppercase group-aria-[current=page]/nav:border-accent group-aria-[current=page]/nav:text-accent"
          >
            {entry.label.slice(0, 1)}
          </span>
          {entry.label}
        </a>
        <button
          type="button"
          aria-label={`${isPinned ? "Unpin" : "Pin"} ${entry.label}`}
          aria-pressed={isPinned}
          onClick={() => {
            pin(entry.name, !isPinned);
          }}
          className={cn(
            "absolute top-1/2 right-1 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-fg-dim hover:bg-elevated hover:text-fg focus-visible:opacity-100 pointer-coarse:opacity-100",
            isPinned
              ? "opacity-0 group-hover/row:opacity-100"
              : "opacity-60 group-hover/row:opacity-100",
          )}
        >
          <Icon
            name="pin"
            className={cn("size-3.5", isPinned && "fill-current")}
          />
        </button>
      </div>
      {entry.Items && (
        <PluginBoundary name={entry.name}>
          <entry.Items
            context={pluginContext(entry.name)}
            path={page?.name === entry.name ? page.path : undefined}
          />
        </PluginBoundary>
      )}
    </div>
  );

  return (
    <div id="plugin-nav" className="flex flex-col gap-0.5 px-2 pb-1">
      {pinned.map((item) => row(item, true))}
      {rest.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showRest}
            onClick={() => {
              setMore(!showRest);
            }}
            className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-ui text-fg-dim hover:bg-hover hover:text-fg"
          >
            <span
              aria-hidden="true"
              className="grid size-6 place-items-center rounded-md text-fg-dim"
            >
              <Icon name="more" />
            </span>
            {showRest ? "Less" : "More"}
          </button>
          {showRest && rest.map((item) => row(item, false))}
        </>
      )}
    </div>
  );
}
