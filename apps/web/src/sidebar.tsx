import { ThemeSwitch } from "./theme";
import type { Environment, Session } from "@pi-cloud/protocol";
import { Badge, Button, cn, fieldClass, Icon } from "@pi-cloud/ui";
import { type ReactElement, useState } from "react";
import { useNow } from "@pi-cloud/plugins/web";
import { api } from "./api";
import { matches } from "./notices";
import {
  ago,
  modelName,
  sessionBadge,
  shortName,
  workspaceName,
} from "./names";
import { PluginBoundary } from "./plugin-boundary";
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
}

export function Sidebar({
  nav,
  route,
  sessions,
  environments,
  showArchived,
  onShowArchived,
  onNewSession,
}: SidebarProps): ReactElement {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const page = pluginRoute(route);

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
    <nav aria-label="Pi Cloud" className="flex h-full flex-col bg-panel">
      <div className="flex items-center justify-between gap-2 py-3 pr-3 pl-4">
        <span className="flex items-center gap-2.5 text-title font-semibold text-fg-strong">
          <span className="grid size-7 place-items-center rounded-md bg-accent font-mono text-ui text-on-accent">
            π
          </span>
          Pi Cloud
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

      <div className="flex flex-col gap-0.5 px-2 pb-0.5">
        <a
          href="#profiles"
          aria-current={route.startsWith("profiles") ? "page" : undefined}
          className="group/nav flex items-center gap-2.5 rounded-md px-2 py-1.5 text-ui text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
        >
          <span
            aria-hidden="true"
            className="grid size-6 place-items-center rounded-md border border-line bg-elevated text-caption font-semibold text-fg-dim uppercase group-aria-[current=page]/nav:border-accent group-aria-[current=page]/nav:text-accent"
          >
            P
          </span>
          Profiles
        </a>
        <a
          href="#environments"
          aria-current={route.startsWith("environments") ? "page" : undefined}
          className="group/nav flex items-center gap-2.5 rounded-md px-2 py-1.5 text-ui text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
        >
          <span
            aria-hidden="true"
            className="grid size-6 place-items-center rounded-md border border-line bg-elevated text-caption font-semibold text-fg-dim uppercase group-aria-[current=page]/nav:border-accent group-aria-[current=page]/nav:text-accent"
          >
            E
          </span>
          Environments
        </a>
      </div>

      {nav.length > 0 && (
        <div id="plugin-nav" className="flex flex-col gap-0.5 px-2 pb-1">
          {nav.map(({ name, label, Items }) => (
            <div key={name} className="flex flex-col gap-0.5">
              <a
                href={`#plugin/${name}`}
                aria-current={route === `plugin/${name}` ? "page" : undefined}
                className="group/nav flex items-center gap-2.5 rounded-md px-2 py-1.5 text-ui text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
              >
                <span
                  aria-hidden="true"
                  className="grid size-6 place-items-center rounded-md border border-line bg-elevated text-caption font-semibold text-fg-dim uppercase group-aria-[current=page]/nav:border-accent group-aria-[current=page]/nav:text-accent"
                >
                  {label.slice(0, 1)}
                </span>
                {label}
              </a>
              {Items && (
                <PluginBoundary name={name}>
                  <Items
                    context={pluginContext(name)}
                    path={page?.name === name ? page.path : undefined}
                  />
                </PluginBoundary>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between border-t border-line px-4 pt-4 pb-2">
        <h2 className="text-caption font-semibold tracking-wide text-fg-dim uppercase">
          Sessions
        </h2>
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
      <div className="border-t border-line px-2 py-2">
        <Button
          variant="ghost"
          onClick={() => {
            void api("/api/auth/logout", {}).finally(() => {
              location.replace("/");
            });
          }}
          className="w-full justify-start text-label"
        >
          Sign out
        </Button>
      </div>
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
        {environments.map(({ id, name, online }) => (
          <li key={id} className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-2 rounded-full",
                online ? "bg-done" : "border border-fg-dim",
              )}
            />
            {name} {online ? "online" : "offline"}
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
