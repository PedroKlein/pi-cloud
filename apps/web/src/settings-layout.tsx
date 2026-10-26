import { Button, Icon } from "@pi-cloud/ui";
import type { ReactElement, ReactNode } from "react";
import { enabledPlugins, pluginTitle } from "./plugins";

interface SettingsSection {
  readonly href: string;
  readonly label: string;
  readonly current: boolean;
}

// Everything that configures Pi Cloud sits on one page with sections, opened
// from the account menu, like Claude Code's settings (ADR 0040).
function sections(route: string): readonly SettingsSection[] {
  return [
    {
      href: "#environments",
      label: "Environments",
      current: route.startsWith("environments"),
    },
    {
      href: "#profiles",
      label: "Profiles",
      current: route.startsWith("profiles"),
    },
    { href: "#plugins", label: "Plugins", current: route === "plugins" },
    { href: "#settings", label: "MCP clients", current: route === "settings" },
    ...enabledPlugins().flatMap(({ name, SettingsSection }) =>
      SettingsSection
        ? [
            {
              href: `#settings/${name}`,
              label: pluginTitle(name),
              current: route === `settings/${name}`,
            },
          ]
        : [],
    ),
  ];
}

export function isSettingsRoute(route: string): boolean {
  return /^(environments|profiles|plugins|settings)(\/|$)/.test(route);
}

export function SettingsLayout({
  route,
  onMenu,
  children,
}: {
  readonly route: string;
  readonly onMenu: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 max-md:flex-col">
      <nav
        aria-label="Settings"
        className="flex shrink-0 gap-0.5 border-line max-md:items-center max-md:overflow-x-auto max-md:border-b max-md:px-2 max-md:py-1.5 md:w-52 md:flex-col md:border-r md:px-2 md:py-6"
      >
        <Button
          variant="ghost"
          iconOnly
          aria-label="Open sessions"
          onClick={onMenu}
          className="shrink-0 md:hidden"
        >
          <Icon name="menu" />
        </Button>
        <h2 className="px-2 pb-2 text-caption font-semibold tracking-wide text-fg-dim uppercase max-md:hidden">
          Settings
        </h2>
        {sections(route).map(({ href, label, current }) => (
          <a
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            className="shrink-0 rounded-md px-2 py-1.5 text-ui whitespace-nowrap text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:font-medium aria-[current=page]:text-fg-strong"
          >
            {label}
          </a>
        ))}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
