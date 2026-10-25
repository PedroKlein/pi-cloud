import type { PluginInfo, SettingSpec, SettingValue } from "@pi-cloud/protocol";
import { Badge, Button, cn, Field, fieldClass, PageTitle } from "@pi-cloud/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { send } from "./api";
import { usePlugins } from "./hooks";
import { settingsOf } from "./plugin-settings";
import { webPartError } from "./plugins";

const states = {
  on: { badge: "done", label: "On" },
  off: { badge: "offline", label: "Off" },
  failed: { badge: "failed", label: "Failed" },
} as const;

export function PluginsPage(): ReactElement {
  const { value: plugins, reload } = usePlugins();

  return (
    <div
      id="plugins-page"
      className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 md:px-10"
    >
      <PageTitle description="Plugins add features to Pi Cloud, for everyone on this server. The server uses new settings at once, open pages after a reload, and Sessions the next time they start.">
        Plugins
      </PageTitle>
      {plugins.some(waitsForRestart) && <Restart />}
      <ul className="flex flex-col gap-3">
        {plugins.map((plugin) => (
          <li
            key={plugin.id}
            aria-label={plugin.title}
            className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-title font-semibold text-fg-strong">
                {plugin.title}
              </h2>
              <Badge state={states[plugin.state].badge}>
                {states[plugin.state].label}
              </Badge>
              {plugin.source === "installed" && (
                <Badge state="offline">Installed</Badge>
              )}
            </div>
            <p className="text-ui text-fg-dim">{plugin.description}</p>
            {plugin.error !== undefined && (
              <p className="text-ui text-failed">
                It failed to start: {plugin.error}
              </p>
            )}
            {webPartError(plugin.id) !== undefined && (
              <p className="text-ui text-failed">
                Its web part didn't load: {webPartError(plugin.id)}
              </p>
            )}
            {plugin.source === "installed" && (
              <Switch plugin={plugin} onChange={reload} />
            )}
            {plugin.settings !== undefined &&
              Object.keys(plugin.settings).length > 0 && (
                <SettingsForm
                  plugin={plugin}
                  settings={plugin.settings}
                  onChange={reload}
                />
              )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// A failed plugin shows its error instead.
function waitsForRestart(plugin: PluginInfo): boolean {
  return (
    plugin.source === "installed" &&
    plugin.state !== "failed" &&
    plugin.turnedOn !== (plugin.state === "on")
  );
}

// Sessions on the server's own runner stop with it, so a restart asks first
// while one is mid-turn (ADR 0022). The page reloads once the server answers
// again.
function Restart(): ReactElement {
  const [state, setState] = useState<"idle" | "restarting">("idle");
  const [error, setError] = useState<string>();

  const restart = async (force: boolean): Promise<void> => {
    const response = await fetch("/api/restart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force }),
    });

    if (response.status === 409) {
      const { sessions } = (await response.json()) as { sessions: number };

      if (
        confirm(
          `${String(sessions)} ${sessions === 1 ? "Session is" : "Sessions are"} mid-turn on the server's own runner and will be interrupted. Restart anyway?`,
        )
      ) {
        await restart(true);
      }

      return;
    }

    if (!response.ok) {
      setError(((await response.json()) as { error: string }).error);

      return;
    }

    setState("restarting");
    await back();
    location.reload();
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel p-4 text-ui">
      <span className="text-fg">
        {state === "restarting"
          ? "Restarting the server…"
          : "Some changes wait for the server to restart."}
      </span>
      {state === "idle" && (
        <Button
          onClick={() => {
            restart(false).catch((reason: unknown) => {
              setError(String(reason));
            });
          }}
        >
          Restart now
        </Button>
      )}
      {error !== undefined && (
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      )}
    </div>
  );
}

// Waits for the server to go away and answer again.
async function back(): Promise<void> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));

    const ok = await fetch("/healthz").then(
      (response) => response.ok,
      () => false,
    );

    if (ok) {
      return;
    }
  }
}

// An installed plugin starts turned off, and turning it on is the user's call
// (ADR 0022). Either way it takes effect when the server restarts.
function Switch({
  plugin,
  onChange,
}: {
  readonly plugin: PluginInfo;
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const pending = waitsForRestart(plugin);

  const turn = (): void => {
    send(`/api/plugins/${plugin.id}`, "PATCH", {
      enabled: !plugin.turnedOn,
    }).then(
      () => {
        setError(undefined);
        onChange();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-3 text-ui">
      <Button onClick={turn}>{plugin.turnedOn ? "Turn off" : "Turn on"}</Button>
      {pending && (
        <span className="text-fg-dim">
          {plugin.turnedOn
            ? "It turns on when the server restarts."
            : "It turns off when the server restarts."}
        </span>
      )}
      {error !== undefined && (
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      )}
    </div>
  );
}

function SettingsForm({
  plugin,
  settings,
  onChange,
}: {
  readonly plugin: PluginInfo;
  readonly settings: Readonly<Record<string, SettingSpec>>;
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSaved(false);

    send(`/api/plugins/${plugin.id}`, "PATCH", {
      settings: settingsOf(settings, new FormData(event.currentTarget)),
    }).then(
      () => {
        setError(undefined);
        setSaved(true);
        onChange();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      aria-label={`${plugin.title} settings`}
      className="flex flex-col gap-4 border-t border-line pt-4"
    >
      {Object.entries(settings).map(([name, spec]) => (
        <SettingField
          key={name}
          name={name}
          spec={spec}
          value={plugin.values[name] ?? spec.default}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" type="submit">
          Save
        </Button>
        <p role="status" className="text-caption">
          {error !== undefined ? (
            <span className="text-failed">{error}</span>
          ) : (
            saved && <span className="text-fg-dim">Saved</span>
          )}
        </p>
      </div>
    </form>
  );
}

function SettingField({
  name,
  spec,
  value,
}: {
  readonly name: string;
  readonly spec: SettingSpec;
  readonly value: SettingValue;
}): ReactElement {
  const label =
    spec.description === undefined
      ? spec.title
      : `${spec.title}. ${spec.description}`;

  switch (spec.type) {
    case "boolean":
      return (
        <label className="flex items-center gap-2 text-ui text-fg">
          <input name={name} type="checkbox" defaultChecked={value === true} />
          {label}
        </label>
      );
    case "choice":
      return (
        <Field label={label}>
          <select
            name={name}
            defaultValue={String(value)}
            className={fieldClass}
          >
            {spec.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
      );
    case "strings":
      return (
        <Field label={`${label} One per line.`}>
          <textarea
            name={name}
            rows={3}
            defaultValue={Array.isArray(value) ? value.join("\n") : ""}
            className={cn(
              fieldClass,
              "min-h-20 resize-y font-mono text-mono-sm",
            )}
          />
        </Field>
      );
    case "number":
      return (
        <Field label={label}>
          <input
            name={name}
            type="number"
            required
            step="any"
            defaultValue={String(value)}
            {...(spec.min !== undefined && { min: spec.min })}
            {...(spec.max !== undefined && { max: spec.max })}
            className={cn(fieldClass, "w-40")}
          />
        </Field>
      );
    case "string":
      return (
        <Field label={label}>
          <input
            name={name}
            defaultValue={String(value)}
            className={fieldClass}
          />
        </Field>
      );
  }
}
