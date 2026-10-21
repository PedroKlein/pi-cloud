import {
  json,
  type PageProps,
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
  chainOf,
  gatewayProvider,
  unhealthy,
} from "../src/gateway";
import type {
  AliasConfig,
  Backend,
  EnvironmentModels,
  Health,
} from "../src/model";

const tiers = ["heavy", "medium", "light", "xlight", "minimal"];
const schedules = ["", "utc-hourly", "utc-midnight", "utc-monthly-1st"];

export const models: WebPlugin = {
  name: "models",
  nav: { label: "Models", Page },
};

function Page({ context }: PageProps): ReactElement {
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
      <PageTitle description="Aliases such as medium-1 name a tier instead of a model. Each Environment maps them to the models its machine has, in fallback order, and a backend that fails is skipped by every session there until it resets.">
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
    saved?.aliases ?? { backends: {} },
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
          </tr>
        </thead>
        <tbody>
          {aliasesOf(config).map((alias) => {
            const [first] = candidates(config, health, alias, now);

            return (
              <tr key={alias.id}>
                <td className={cn(cell, "font-mono text-mono-sm")}>
                  {gatewayProvider}/{alias.id}
                </td>
                <td
                  className={cn(
                    cell,
                    "font-mono text-mono-sm",
                    !first && "text-failed",
                  )}
                >
                  {first
                    ? `${first.backend}/${first.modelId}`
                    : "no healthy backend"}
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

  const order = [
    ...chainOf(draft),
    ...Object.keys(draft.backends).filter(
      (name) => draft.backends[name]?.forceOnly === true,
    ),
  ];

  const withBackends = (
    names: readonly string[],
    backends = draft.backends,
  ): AliasConfig => ({
    ...(draft.defaultAlias !== undefined && {
      defaultAlias: draft.defaultAlias,
    }),
    fallbackChain: names.filter((name) => backends[name]?.forceOnly !== true),
    backends: Object.fromEntries(
      names.flatMap((name) => {
        const backend = backends[name];

        return backend ? [[name, backend]] : [];
      }),
    ),
  });

  const move = (index: number, by: number): void => {
    const next = [...order];
    const [name] = next.splice(index, 1);
    if (name !== undefined) {
      next.splice(index + by, 0, name);
      onChange(withBackends(next));
    }
  };

  const providers = [
    ...new Set(environment.models.map(({ provider }) => provider)),
  ].filter((provider) => !order.includes(provider));

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
          {aliasesOf(draft).map(({ id }) => (
            <option key={id} value={id}>
              {gatewayProvider}/{id}
            </option>
          ))}
        </select>
      </label>

      <h3 className="text-ui font-semibold text-fg-strong">
        Backends, in fallback order
      </h3>
      {order.map((name, index) => (
        <BackendEditor
          key={name}
          environment={environment}
          name={name}
          backend={draft.backends[name] ?? { tiers: {} }}
          down={unhealthy(health, name, now)}
          first={index === 0}
          last={index === order.length - 1}
          onChange={(backend) => {
            onChange(
              withBackends(order, { ...draft.backends, [name]: backend }),
            );
          }}
          onMove={(by) => {
            move(index, by);
          }}
          onRemove={() => {
            onChange(withBackends(order.filter((other) => other !== name)));
          }}
        />
      ))}
      {providers.length > 0 && (
        <select
          aria-label="Add a backend"
          value=""
          onChange={(event) => {
            onChange(
              withBackends([...order, event.target.value], {
                ...draft.backends,
                [event.target.value]: { tiers: {} },
              }),
            );
          }}
          className={cn(fieldClass, "self-start")}
        >
          <option value="">Add a backend…</option>
          {providers.map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function BackendEditor({
  environment,
  name,
  backend,
  down,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  readonly environment: Environment;
  readonly name: string;
  readonly backend: Backend;
  readonly down: ReturnType<typeof unhealthy>;
  readonly first: boolean;
  readonly last: boolean;
  readonly onChange: (backend: Backend) => void;
  readonly onMove: (by: number) => void;
  readonly onRemove: () => void;
}): ReactElement {
  const list = `models-${environment.id}-${name}`;

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-line bg-bg p-4">
      <legend className="flex items-center gap-2 px-1 font-mono text-mono">
        {name}
        {down ? (
          <Badge state="failed">
            Unhealthy until {new Date(down.until).toLocaleString()} (
            {down.reason})
          </Badge>
        ) : (
          <Badge state="done">Healthy</Badge>
        )}
      </legend>
      <datalist id={list}>
        {environment.models
          .filter(({ provider }) => provider === name)
          .map(({ id }) => (
            <option key={id} value={id} />
          ))}
      </datalist>
      <div className="grid gap-2 sm:grid-cols-[max-content_1fr] sm:items-center sm:gap-x-4">
        {tiers.map((tier) => (
          <label key={tier} className="contents text-label text-fg-dim">
            <span>{tier}</span>
            <input
              list={list}
              placeholder="model ids, comma-separated"
              defaultValue={[backend.tiers[tier] ?? []].flat().join(", ")}
              onBlur={(event) => {
                const ids = event.target.value
                  .split(",")
                  .map((id) => id.trim())
                  .filter((id) => id !== "");

                const others = Object.entries(backend.tiers).filter(
                  ([other]) => other !== tier,
                );

                onChange({
                  ...backend,
                  tiers: Object.fromEntries(
                    ids.length === 0 ? others : [...others, [tier, ids]],
                  ),
                });
              }}
              className={cn(fieldClass, "font-mono text-mono-sm")}
            />
          </label>
        ))}
      </div>
      <Settings backend={backend} onChange={onChange} />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={first}
          onClick={() => {
            onMove(-1);
          }}
        >
          Up
        </Button>
        <Button
          disabled={last}
          onClick={() => {
            onMove(1);
          }}
        >
          Down
        </Button>
        <Button variant="danger" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </fieldset>
  );
}

function Settings({
  backend,
  onChange,
}: {
  readonly backend: Backend;
  readonly onChange: (backend: Backend) => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-4 text-label text-fg-dim">
      <label className="flex items-center gap-2">
        Cap status codes
        <input
          placeholder="402"
          defaultValue={(backend.capStatusCodes ?? []).join(", ")}
          onBlur={(event) => {
            const parsed = event.target.value
              .split(",")
              .map((code) => Number(code.trim()))
              .filter((code) => Number.isInteger(code) && code > 0);

            const { capStatusCodes: _, ...rest } = backend;

            onChange(
              parsed.length === 0 ? rest : { ...rest, capStatusCodes: parsed },
            );
          }}
          className={cn(fieldClass, "w-28")}
        />
      </label>
      <label className="flex items-center gap-2">
        Reset
        <select
          value={backend.resetSchedule ?? ""}
          onChange={(event) => {
            const { resetSchedule: _, ...rest } = backend;

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
  );
}
