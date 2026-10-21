import { Button, cn, Icon } from "@pi-cloud/ui";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { useEnvironments, useHash, useSessions } from "./hooks";
import { NewSessionDialog } from "./new-session";
import { mountPage, type NavEntry } from "./plugins";
import { SessionView } from "./session-view";
import { Sidebar } from "./sidebar";

export function App({
  nav,
}: {
  readonly nav: readonly NavEntry[];
}): ReactElement {
  const route = useHash();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const sessions = useSessions(showArchived);
  const environments = useEnvironments();

  const page = route.startsWith("plugin/")
    ? route.slice("plugin/".length)
    : undefined;

  const openDrawer = (): void => {
    setDrawer(true);
  };

  const content = (): ReactElement => {
    if (page !== undefined) {
      return <PluginPage key={page} name={page} onMenu={openDrawer} />;
    }

    if (route === "") {
      return (
        <Empty
          onNewSession={() => {
            setCreating(true);
          }}
          onMenu={openDrawer}
        />
      );
    }

    return (
      <SessionView
        key={route}
        sessionId={route}
        environments={environments.value}
        onSessionChange={sessions.reload}
        onMenu={openDrawer}
      />
    );
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-bg font-sans text-ui text-fg">
      <div
        aria-hidden="true"
        onClick={() => {
          setDrawer(false);
        }}
        className={cn(
          "fixed inset-0 z-10 bg-black/55 md:hidden",
          !drawer && "hidden",
        )}
      />
      <aside
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("a")) {
            setDrawer(false);
          }
        }}
        className={cn(
          "z-20 w-sidebar shrink-0 border-r border-line max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[min(320px,85vw)] max-md:shadow-pop max-md:transition-transform motion-reduce:transition-none",
          !drawer && "max-md:-translate-x-full",
        )}
      >
        <Sidebar
          nav={nav}
          route={route}
          sessions={sessions.value}
          environments={environments.value}
          showArchived={showArchived}
          onShowArchived={setShowArchived}
          onNewSession={() => {
            setCreating(true);
          }}
        />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">{content()}</main>

      <NewSessionDialog
        open={creating}
        environments={environments.value}
        onClose={() => {
          setCreating(false);
        }}
      />
    </div>
  );
}

function MenuButton({ onMenu }: { readonly onMenu: () => void }): ReactElement {
  return (
    <Button
      variant="ghost"
      iconOnly
      aria-label="Open sessions"
      onClick={onMenu}
      className="md:hidden"
    >
      <Icon name="menu" />
    </Button>
  );
}

function Empty({
  onNewSession,
  onMenu,
}: {
  readonly onNewSession: () => void;
  readonly onMenu: () => void;
}): ReactElement {
  return (
    <>
      <div className="p-2 md:hidden">
        <MenuButton onMenu={onMenu} />
      </div>
      <div className="m-auto flex max-w-sm flex-col items-center gap-4 p-8 text-center">
        <span className="grid size-14 place-items-center rounded-xl bg-accent font-mono text-display text-on-accent shadow-card">
          π
        </span>
        <h1 className="text-display font-semibold text-fg-strong">Pi Cloud</h1>
        <p className="text-fg-dim">
          Pick a session, or start a new one on one of your machines.
        </p>
        <Button variant="primary" onClick={onNewSession}>
          <Icon name="plus" />
          Start a session
        </Button>
      </div>
    </>
  );
}

function PluginPage({
  name,
  onMenu,
}: {
  readonly name: string;
  readonly onMenu: () => void;
}): ReactElement {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) {
      return undefined;
    }

    return mountPage(name, host.current);
  }, [name]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="p-2 md:hidden">
        <MenuButton onMenu={onMenu} />
      </div>
      <div
        id="plugin-page"
        ref={host}
        className="legacy mx-auto max-w-5xl px-4 py-8 md:px-10"
      />
    </div>
  );
}
