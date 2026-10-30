import { Button, cn, Icon } from "@pipoca/ui";
import { type ReactElement, useEffect, useRef, useState } from "react";
import {
  useEnvironments,
  useHash,
  useProfiles,
  useSessions,
  useSettledNotices,
} from "./hooks";
import { ShellMenu } from "./embedded-session";
import { NewSessionDialog } from "./new-session";
import { PluginBoundary } from "./plugin-boundary";
import { EnvironmentsPage } from "./environments";
import { FirstRun } from "./first-run";
import { PluginsPage } from "./plugins-page";
import { ProfilesPage } from "./profiles";
import {
  enabledPlugins,
  type NavEntry,
  pageFills,
  pluginContext,
  pluginRoute,
  sessionHref,
} from "./plugins";
import { SessionView } from "./session-view";
import { SettingsPage } from "./settings";
import { isSettingsRoute, SettingsLayout } from "./settings-layout";
import { Mark } from "./mark";
import { PeoplePage } from "./people";
import { Sidebar } from "./sidebar";

export function App({
  nav,
  user,
  admin,
}: {
  readonly nav: readonly NavEntry[];
  readonly user: string;
  readonly admin: boolean;
}): ReactElement {
  const route = useHash();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [drawerRoute, setDrawerRoute] = useState(route);
  const aside = useRef<HTMLElement>(null);
  const sessions = useSessions(showArchived);
  const environments = useEnvironments();
  const profiles = useProfiles();
  useSettledNotices(sessions.value, route);

  if (drawerRoute !== route) {
    setDrawerRoute(route);
    setDrawer(false);
  }

  useEffect(() => {
    if (!drawer) {
      return;
    }

    const opener = document.activeElement;

    aside.current
      ?.querySelector<HTMLElement>("a[href], button:not(:disabled), input")
      ?.focus();

    const wide = matchMedia("(width >= 48rem)");

    const close = (): void => {
      setDrawer(false);
    };

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };

    wide.addEventListener("change", close);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      wide.removeEventListener("change", close);
      document.removeEventListener("keydown", closeOnEscape);

      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    };
  }, [drawer]);

  const page = pluginRoute(route);
  const listed = sessions.value.find(({ id }) => id === route);
  const moved = listed ? sessionHref(listed) : undefined;

  // Old links and notices name a Session its plugin now shows (ADR 0028).
  useEffect(() => {
    if (moved !== undefined && moved !== `#${route}`) {
      location.replace(moved);
    }
  }, [moved, route]);

  const openDrawer = (): void => {
    setDrawer(true);
  };

  const settingsContent = (): ReactElement => {
    const profilesRoute = /^profiles\/?(.*)$/.exec(route);
    if (profilesRoute) {
      return (
        <ProfilesPage
          profiles={profiles.value}
          selected={profilesRoute[1] ?? ""}
          onChange={profiles.reload}
        />
      );
    }

    const environmentsRoute = /^environments\/?(.*)$/.exec(route);
    if (environmentsRoute) {
      return (
        <EnvironmentsPage
          environments={environments.value}
          selected={environmentsRoute[1] ?? ""}
          onChange={environments.reload}
        />
      );
    }

    if (route === "plugins") {
      return <PluginsPage />;
    }

    if (route === "people" && admin) {
      return <PeoplePage />;
    }

    const name = /^settings\/(.+)$/.exec(route)?.[1];

    const Section =
      name === undefined
        ? undefined
        : enabledPlugins().find((plugin) => plugin.name === name)
            ?.SettingsSection;

    if (name !== undefined && Section) {
      return (
        <div className="mx-auto flex w-full max-w-form flex-col px-4 py-10 md:px-10">
          <PluginBoundary name={name}>
            <Section context={pluginContext(name)} />
          </PluginBoundary>
        </div>
      );
    }

    return <SettingsPage />;
  };

  const content = (): ReactElement => {
    if (page !== undefined) {
      return (
        <PluginPage
          key={page.name}
          name={page.name}
          path={page.path}
          onMenu={openDrawer}
        />
      );
    }

    if (moved !== undefined && moved !== `#${route}`) {
      return <div className="flex-1" />;
    }

    if (isSettingsRoute(route)) {
      return (
        <SettingsLayout route={route} admin={admin} onMenu={openDrawer}>
          {settingsContent()}
        </SettingsLayout>
      );
    }

    if (route === "") {
      const home = enabledPlugins().find(({ Home }) => Home !== undefined);

      const newSession = (): void => {
        setCreating(true);
      };

      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="p-2 md:hidden">
            <MenuButton onMenu={openDrawer} />
          </div>
          {environments.loaded && (
            <FirstRun environments={environments.value} />
          )}
          {home?.Home ? (
            <PluginBoundary name={home.name}>
              <home.Home
                context={pluginContext(home.name)}
                onNewSession={newSession}
              />
            </PluginBoundary>
          ) : (
            <Empty onNewSession={newSession} />
          )}
        </div>
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
        ref={aside}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("a")) {
            setDrawer(false);
          }
        }}
        className={cn(
          "z-20 w-sidebar shrink-0 border-r border-line max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[min(320px,85vw)] max-md:shadow-pop",
          // Showing it at once lets focus move in; hiding it after the slide keeps the slide visible.
          drawer
            ? "max-md:motion-safe:transition-[translate]"
            : "max-md:invisible max-md:-translate-x-full max-md:motion-safe:transition-[translate,visibility]",
        )}
      >
        <Sidebar
          nav={nav}
          route={route}
          sessions={sessions.value}
          environments={environments.value}
          showArchived={showArchived}
          onShowArchived={setShowArchived}
          user={user}
          onNewSession={() => {
            setCreating(true);
          }}
        />
      </aside>

      <main inert={drawer} className="flex min-w-0 flex-1 flex-col">
        {content()}
      </main>

      <NewSessionDialog
        open={creating}
        environments={environments.value}
        profiles={profiles.value}
        sessions={sessions.value}
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
}: {
  readonly onNewSession: () => void;
}): ReactElement {
  return (
    <div className="m-auto flex max-w-sm flex-col items-center gap-4 p-8 text-center">
      <Mark className="size-16" />
      <h1 className="font-serif text-hero font-light text-fg-strong">pipoca</h1>
      <p className="text-fg-dim">
        Pick a session, or start a new one on one of your machines.
      </p>
      <Button variant="primary" onClick={onNewSession}>
        <Icon name="plus" />
        Start a session
      </Button>
    </div>
  );
}

function PluginPage({
  name,
  path,
  onMenu,
}: {
  readonly name: string;
  readonly path: string;
  readonly onMenu: () => void;
}): ReactElement {
  const Page = enabledPlugins().find((plugin) => plugin.name === name)?.nav
    ?.Page;

  const body = Page ? (
    <PluginBoundary key={name} name={name}>
      <Page context={pluginContext(name)} path={path} />
    </PluginBoundary>
  ) : (
    <p className="text-fg-dim">This page isn&apos;t available.</p>
  );

  if (pageFills(name, path)) {
    return (
      <ShellMenu value={onMenu}>
        <div
          id="plugin-page"
          data-plugin={name}
          className="flex min-h-0 min-w-0 flex-1"
        >
          {body}
        </div>
      </ShellMenu>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="p-2 md:hidden">
        <MenuButton onMenu={onMenu} />
      </div>
      <div
        id="plugin-page"
        data-plugin={name}
        className="mx-auto flex w-full max-w-form flex-col px-4 py-10 md:px-10"
      >
        {body}
      </div>
    </div>
  );
}
