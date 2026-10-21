import type { Environment, Session } from "@pi-cloud/protocol";
import { Badge, Button, cn, Icon } from "@pi-cloud/ui";
import type { ReactElement } from "react";
import { modelName, sessionBadge, workspaceName } from "./names";
import type { NavEntry } from "./plugins";

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
  return (
    <nav aria-label="Pi Cloud" className="flex h-full flex-col bg-panel">
      <div className="flex items-center justify-between gap-2 py-3 pr-3 pl-4">
        <span className="text-title font-semibold text-fg-strong">
          Pi Cloud
        </span>
        <Button
          variant="primary"
          iconOnly
          aria-label="New session"
          onClick={onNewSession}
        >
          <Icon name="plus" />
        </Button>
      </div>

      {nav.length > 0 && (
        <div id="plugin-nav" className="flex flex-col gap-0.5 px-2">
          {nav.map(({ name, label }) => (
            <a
              key={name}
              href={`#plugin/${name}`}
              aria-current={route === `plugin/${name}` ? "page" : undefined}
              className="rounded-md px-3 py-1.5 text-ui text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
            >
              {label}
            </a>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between px-4 pt-4 pb-1">
        <h2 className="text-label font-medium text-fg-dim">Sessions</h2>
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

      <ul
        id="sessions"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2"
      >
        {sessions.toReversed().map((session) => (
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

      <EnvironmentStatus environments={environments} />
    </nav>
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

  const meta = [
    environment?.name ?? session.provider,
    ...(session.model ? [modelName(session.model)] : []),
    ...(session.archivedAt === null ? [] : ["archived"]),
  ].join(" · ");

  return (
    <li data-id={session.id}>
      <a
        href={`#${session.id}`}
        aria-current={current ? "page" : undefined}
        className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5 rounded-md px-3 py-2 text-fg hover:bg-hover aria-[current=page]:bg-hover"
      >
        <span
          className={cn(
            "truncate text-ui font-medium",
            current && "text-fg-strong",
          )}
        >
          {workspaceName(session.workspace)}
        </span>
        {badge ? <Badge state={badge.state}>{badge.label}</Badge> : <span />}
        <span className="col-span-2 truncate text-caption text-fg-dim">
          {meta}
        </span>
      </a>
    </li>
  );
}

function EnvironmentStatus({
  environments,
}: {
  readonly environments: readonly Environment[];
}): ReactElement {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-4 py-3 text-caption text-fg-dim">
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
  );
}
