import type { WebContext, WebPlugin } from "@pi-cloud/plugins/web";
import type { Environment } from "@pi-cloud/protocol";
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
  nav: {
    label: "Models",
    mount: (element, context) => {
      const render = async (): Promise<void> => {
        element.replaceChildren(await page(context, render));
      };

      void render();

      return () => undefined;
    },
  },
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) {
    element.textContent = text;
  }

  element.append(...children);

  return element;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const element = el("button", text);
  element.type = "button";
  element.addEventListener("click", onClick);

  return element;
}

async function page(
  context: WebContext,
  refresh: () => Promise<void>,
): Promise<HTMLElement> {
  const environments = (await (
    await fetch("/api/environments")
  ).json()) as Environment[];

  const configs = (await (
    await context.request("environments")
  ).json()) as EnvironmentModels[];

  return el(
    "section",
    undefined,
    el("h2", "Models"),
    el(
      "p",
      "Aliases such as medium-1 name a tier instead of a model. Each Environment maps them to the models its machine has, in fallback order, and a backend that fails is skipped by every session there until it resets.",
    ),
    ...environments.map((environment) =>
      environmentSection(
        context,
        environment,
        configs.find(({ environmentId }) => environmentId === environment.id),
        refresh,
      ),
    ),
  );
}

function environmentSection(
  context: WebContext,
  environment: Environment,
  saved: EnvironmentModels | undefined,
  refresh: () => Promise<void>,
): HTMLElement {
  const health = saved?.health ?? { version: 1, unhealthyUntil: {} };
  const section = el("section");
  section.dataset["environment"] = environment.id;

  let draft = structuredClone<AliasConfig>(saved?.aliases ?? { backends: {} });

  const save = async (aliases: AliasConfig | null): Promise<void> => {
    const response = await context.request(
      `environments/${encodeURIComponent(environment.id)}`,
      { aliases },
    );

    if (!response.ok) {
      alert(((await response.json()) as { error: string }).error);

      return;
    }

    await refresh();
  };

  const render = (): void => {
    section.replaceChildren(
      el(
        "h3",
        `${environment.name} (${environment.provider}, ${environment.online ? "online" : "offline"})`,
      ),
      ...(saved?.aliases ? [routing(saved.aliases, health)] : []),
      editor(environment, draft, health, (next) => {
        draft = next;
        render();
      }),
      el(
        "p",
        undefined,
        button("Save", () => {
          void save(draft);
        }),
        document.createTextNode(" "),
        button("Turn aliases off", () => {
          void save(null);
        }),
      ),
    );
  };

  render();

  return section;
}

function routing(config: AliasConfig, health: Health): HTMLElement {
  const now = new Date();

  return el(
    "table",
    undefined,
    el(
      "thead",
      undefined,
      el("tr", undefined, el("th", "Alias"), el("th", "Routes to now")),
    ),
    el(
      "tbody",
      undefined,
      ...aliasesOf(config).map((alias) => {
        const [first] = candidates(config, health, alias, now);

        return el(
          "tr",
          undefined,
          el("td", `${gatewayProvider}/${alias.id}`),
          el(
            "td",
            first ? `${first.backend}/${first.modelId}` : "no healthy backend",
          ),
        );
      }),
    ),
  );
}

function editor(
  environment: Environment,
  draft: AliasConfig,
  health: Health,
  change: (next: AliasConfig) => void,
): HTMLElement {
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

  const update = (name: string, backend: Backend): void => {
    change(withBackends(order, { ...draft.backends, [name]: backend }));
  };

  const move = (index: number, by: number): void => {
    const next = [...order];
    const [name] = next.splice(index, 1);
    if (name !== undefined) {
      next.splice(index + by, 0, name);
      change(withBackends(next));
    }
  };

  const providers = [
    ...new Set(environment.models.map(({ provider }) => provider)),
  ].filter((provider) => !order.includes(provider));

  const add = el(
    "select",
    undefined,
    el("option", "Add a backend…"),
    ...providers.map((provider) => el("option", provider)),
  );

  add.addEventListener("change", () => {
    if (add.selectedIndex > 0) {
      change(
        withBackends([...order, add.value], {
          ...draft.backends,
          [add.value]: { tiers: {} },
        }),
      );
    }
  });

  const fallback = el(
    "select",
    undefined,
    el("option", "The machine's Pi default"),
    ...aliasesOf(draft).map(({ id }) => {
      const option = el("option", `${gatewayProvider}/${id}`);
      option.value = id;
      option.selected = id === draft.defaultAlias;

      return option;
    }),
  );

  fallback.addEventListener("change", () => {
    const { defaultAlias: _, ...rest } = draft;

    change(
      fallback.selectedIndex === 0
        ? rest
        : { ...rest, defaultAlias: fallback.value },
    );
  });

  return el(
    "div",
    undefined,
    el("label", "Model for sessions that name none ", fallback),
    el("h4", "Backends, in fallback order"),
    ...order.map((name, index) => {
      const backend = draft.backends[name] ?? { tiers: {} };
      const down = unhealthy(health, name, now);
      const list = `models-${environment.id}-${name}`;

      return el(
        "fieldset",
        undefined,
        el(
          "legend",
          `${name}: ${down ? `unhealthy until ${new Date(down.until).toLocaleString()} (${down.reason})` : "healthy"}`,
        ),
        datalist(
          list,
          environment.models
            .filter(({ provider }) => provider === name)
            .map(({ id }) => id),
        ),
        ...tiers.map((tier) => {
          const input = el("input");
          input.setAttribute("list", list);
          input.placeholder = "model ids, comma-separated";
          input.value = [backend.tiers[tier] ?? []].flat().join(", ");

          input.addEventListener("change", () => {
            const ids = input.value
              .split(",")
              .map((id) => id.trim())
              .filter((id) => id !== "");

            const others = Object.entries(backend.tiers).filter(
              ([other]) => other !== tier,
            );

            update(name, {
              ...backend,
              tiers: Object.fromEntries(
                ids.length === 0 ? others : [...others, [tier, ids]],
              ),
            });
          });

          return el("label", `${tier} `, input);
        }),
        settings(backend, (next) => {
          update(name, next);
        }),
        el(
          "p",
          undefined,
          button("Up", () => {
            move(index, -1);
          }),
          button("Down", () => {
            move(index, 1);
          }),
          button("Remove", () => {
            change(withBackends(order.filter((other) => other !== name)));
          }),
        ),
      );
    }),
    add,
  );
}

function datalist(id: string, values: readonly string[]): HTMLDataListElement {
  const list = el(
    "datalist",
    undefined,
    ...values.map((value) => {
      const option = el("option");
      option.value = value;

      return option;
    }),
  );

  list.id = id;

  return list;
}

function settings(
  backend: Backend,
  update: (next: Backend) => void,
): HTMLElement {
  const codes = el("input");
  codes.placeholder = "402";
  codes.value = (backend.capStatusCodes ?? []).join(", ");

  codes.addEventListener("change", () => {
    const parsed = codes.value
      .split(",")
      .map((code) => Number(code.trim()))
      .filter((code) => Number.isInteger(code) && code > 0);

    const { capStatusCodes: _, ...rest } = backend;
    update(parsed.length === 0 ? rest : { ...rest, capStatusCodes: parsed });
  });

  const schedule = el(
    "select",
    undefined,
    ...schedules.map((value) => {
      const option = el("option", value === "" ? "1 hour after a cap" : value);
      option.value = value;
      option.selected = (backend.resetSchedule ?? "") === value;

      return option;
    }),
  );

  schedule.addEventListener("change", () => {
    const { resetSchedule: _, ...rest } = backend;

    update(
      schedule.value === "" ? rest : { ...rest, resetSchedule: schedule.value },
    );
  });

  return el(
    "p",
    undefined,
    el("label", "Cap status codes ", codes),
    el("label", " Reset ", schedule),
  );
}
