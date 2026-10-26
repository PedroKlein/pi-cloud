import {
  json,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pi-cloud/plugins/web";
import type { Environment } from "@pi-cloud/protocol";
import {
  Badge,
  Button,
  cn,
  fieldClass,
  PageTitle,
  Section,
} from "@pi-cloud/ui";
import { type ReactElement, useState } from "react";
import {
  aliasesOf,
  candidates,
  gatewayProvider,
  modelKey,
  unhealthy,
} from "../src/gateway";
import {
  type AliasConfig,
  type EnvironmentModels,
  type Health,
  modelRef,
  type ProviderSettings,
} from "../src/model";

const schedules = ["", "utc-hourly", "utc-midnight", "utc-monthly-1st"];

export const models: WebPlugin = {
  name: "models",
  SettingsSection: Page,
};

function Page({ context }: { readonly context: WebContext }): ReactElement {
  const { value, reload } = useLoaded(
    async () =>
      Promise.all([
        json<Environment[]>(fetch("/api/environments")),
        json<EnvironmentModels[]>(context.request("environments")),
      ]),
    "models",
  );

  const [environments, configs] = value ?? [[], []];

  return (
    <>
      <PageTitle description="An alias such as medium-1 names a list of models, tried in order, that can mix providers. Each Environment has its own aliases, and a model that fails is skipped by every session there until it cools down or its provider resets.">
        Models
      </PageTitle>
      {environments.map((environment) => {
        const saved = configs.find(
          ({ environmentId }) => environmentId === environment.id,
        );

        return (
          <EnvironmentSection
            key={`${environment.id}-${JSON.stringify(saved?.aliases ?? null)}`}
            context={context}
            environment={environment}
            saved={saved}
            onSaved={reload}
          />
        );
      })}
    </>
  );
}

function EnvironmentSection({
  context,
  environment,
  saved,
  onSaved,
}: {
  readonly context: WebContext;
  readonly environment: Environment;
  readonly saved: EnvironmentModels | undefined;
  readonly onSaved: () => void;
}): ReactElement {
  const health = saved?.health ?? { version: 1, unhealthyUntil: {} };

  const [draft, setDraft] = useState<AliasConfig>(
    saved?.aliases ?? { models: {} },
  );

  const save = async (aliases: AliasConfig | null): Promise<void> => {
    const response = await context.request(
      `environments/${encodeURIComponent(environment.id)}`,
      { aliases },
    );

    if (!response.ok) {
      alert(((await response.json()) as { error: string }).error);

      return;
    }

    onSaved();
  };

  return (
    <Section
      title={
        <span className="flex items-center gap-3">
          {environment.name}
          <span className="text-label font-normal text-fg-dim">
            {environment.provider}
          </span>
          <Badge state={environment.online ? "done" : "offline"}>
            {environment.online ? "Online" : "Offline"}
          </Badge>
        </span>
      }
    >
      <div
        data-environment={environment.id}
        className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5"
      >
        {saved?.aliases && <Routing config={saved.aliases} health={health} />}
        <Editor
          environment={environment}
          draft={draft}
          health={health}
          onChange={setDraft}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={() => {
              void save(draft);
            }}
          >
            Save
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              void save(null);
            }}
          >
            Turn aliases off
          </Button>
        </div>
      </div>
    </Section>
  );
}

function Routing({
  config,
  health,
}: {
  readonly config: AliasConfig;
  readonly health: Health;
}): ReactElement {
  const now = new Date();
  const cell = "border-b border-line px-3 py-2 text-left";

  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full border-collapse text-ui [&_tr:last-child>td]:border-b-0">
        <thead className="bg-elevated text-label text-fg-dim">
          <tr>
            <th className={cn(cell, "font-medium")}>Alias</th>
            <th className={cn(cell, "font-medium")}>Routes to now</th>
            <th className={cn(cell, "font-medium")}>Skipped</th>
          </tr>
        </thead>
        <tbody>
          {aliasesOf(config).map((alias) => {
            const [first] = candidates(config, health, alias, now);

            const skipped = (config.models[alias] ?? []).flatMap((value) => {
              const model = modelRef(value);
              const down = model && unhealthy(health, model, now);

              return down
                ? [`${value} until ${new Date(down.until).toLocaleString()}`]
                : [];
            });

            return (
              <tr key={alias}>
                <td className={cn(cell, "font-mono text-mono-sm")}>
                  {gatewayProvider}/{alias}
                </td>
                <td
                  className={cn(
                    cell,
                    "font-mono text-mono-sm",
                    !first && "text-failed",
                  )}
                >
                  {first ? modelKey(first) : "no healthy model"}
                </td>
                <td className={cn(cell, "font-mono text-mono-sm text-fg-dim")}>
                  {skipped.join(", ")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Editor({
  environment,
  draft,
  health,
  onChange,
}: {
  readonly environment: Environment;
  readonly draft: AliasConfig;
  readonly health: Health;
  readonly onChange: (next: AliasConfig) => void;
}): ReactElement {
  const now = new Date();
  const list = `models-${environment.id}`;
  const [name, setName] = useState("");

  const setModels = (next: AliasConfig["models"]): void => {
    const { defaultAlias, ...rest } = draft;

    onChange({
      ...rest,
      models: next,
      ...(defaultAlias !== undefined &&
        defaultAlias in next && { defaultAlias }),
    });
  };

  const providers = [
    ...new Set(
      Object.values(draft.models)
        .flat()
        .flatMap((value) => modelRef(value)?.provider ?? []),
    ),
  ];

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-wrap items-center gap-3 text-label text-fg-dim">
        Model for sessions that name none
        <select
          value={draft.defaultAlias ?? ""}
          onChange={(event) => {
            const { defaultAlias: _, ...rest } = draft;

            onChange(
              event.target.value === ""
                ? rest
                : { ...rest, defaultAlias: event.target.value },
            );
          }}
          className={fieldClass}
        >
          <option value="">The machine&apos;s Pi default</option>
          {aliasesOf(draft).map((alias) => (
            <option key={alias} value={alias}>
              {gatewayProvider}/{alias}
            </option>
          ))}
        </select>
      </label>

      <h3 className="text-ui font-semibold text-fg-strong">
        Aliases, each with its models in fallback order
      </h3>
      <datalist id={list}>
        {environment.models
          .filter(({ provider }) => provider !== gatewayProvider)
          .map((model) => (
            <option key={modelKey(model)} value={modelKey(model)} />
          ))}
      </datalist>
      <div className="grid gap-2 sm:grid-cols-[max-content_1fr_max-content] sm:items-center sm:gap-x-4">
        {aliasesOf(draft).map((alias) => (
          <label key={alias} className="contents text-label text-fg-dim">
            <span className="font-mono text-mono-sm">{alias}</span>
            <input
              list={list}
              placeholder="provider/model, comma-separated"
              defaultValue={(draft.models[alias] ?? []).join(", ")}
              onBlur={(event) => {
                setModels({
                  ...draft.models,
                  [alias]: event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter((value) => value !== ""),
                });
              }}
              className={cn(fieldClass, "font-mono text-mono-sm")}
            />
            <Button
              variant="danger"
              onClick={() => {
                setModels(
                  Object.fromEntries(
                    Object.entries(draft.models).filter(
                      ([other]) => other !== alias,
                    ),
                  ),
                );
              }}
            >
              Remove
            </Button>
          </label>
        ))}
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name !== "" && !(name in draft.models)) {
            setModels({ ...draft.models, [name]: [] });
            setName("");
          }
        }}
      >
        <input
          aria-label="New alias name"
          placeholder="medium-1"
          value={name}
          onChange={(event) => {
            setName(event.target.value.trim());
          }}
          className={cn(fieldClass, "font-mono text-mono-sm")}
        />
        <Button type="submit">Add alias</Button>
      </form>

      {providers.length > 0 && (
        <>
          <h3 className="text-ui font-semibold text-fg-strong">Providers</h3>
          {providers.map((provider) => (
            <ProviderEditor
              key={provider}
              name={provider}
              settings={draft.providers?.[provider] ?? {}}
              down={health.unhealthyUntil[provider]}
              now={now}
              onChange={(settings) => {
                const others = Object.entries(draft.providers ?? {}).filter(
                  ([other]) => other !== provider,
                );

                onChange({
                  ...draft,
                  providers: Object.fromEntries(
                    Object.keys(settings).length === 0
                      ? others
                      : [...others, [provider, settings]],
                  ),
                });
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}

function ProviderEditor({
  name,
  settings,
  down,
  now,
  onChange,
}: {
  readonly name: string;
  readonly settings: ProviderSettings;
  readonly down: Health["unhealthyUntil"][string] | undefined;
  readonly now: Date;
  readonly onChange: (settings: ProviderSettings) => void;
}): ReactElement {
  const capped = down !== undefined && Date.parse(down.until) > now.getTime();

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-line bg-bg p-4">
      <legend className="flex items-center gap-2 px-1 font-mono text-mono">
        {name}
        {capped ? (
          <Badge state="failed">
            Capped until {new Date(down.until).toLocaleString()} ({down.reason})
          </Badge>
        ) : (
          <Badge state="done">Healthy</Badge>
        )}
      </legend>
      <div className="flex flex-wrap items-center gap-4 text-label text-fg-dim">
        <label className="flex items-center gap-2">
          Cap status codes
          <input
            placeholder="402"
            defaultValue={(settings.capStatusCodes ?? []).join(", ")}
            onBlur={(event) => {
              const parsed = event.target.value
                .split(",")
                .map((code) => Number(code.trim()))
                .filter((code) => Number.isInteger(code) && code > 0);

              const { capStatusCodes: _, ...rest } = settings;

              onChange(
                parsed.length === 0
                  ? rest
                  : { ...rest, capStatusCodes: parsed },
              );
            }}
            className={cn(fieldClass, "w-28")}
          />
        </label>
        <label className="flex items-center gap-2">
          Reset
          <select
            value={settings.resetSchedule ?? ""}
            onChange={(event) => {
              const { resetSchedule: _, ...rest } = settings;

              onChange(
                event.target.value === ""
                  ? rest
                  : { ...rest, resetSchedule: event.target.value },
              );
            }}
            className={fieldClass}
          >
            {schedules.map((value) => (
              <option key={value} value={value}>
                {value === "" ? "1 hour after a cap" : value}
              </option>
            ))}
          </select>
        </label>
      </div>
    </fieldset>
  );
}
