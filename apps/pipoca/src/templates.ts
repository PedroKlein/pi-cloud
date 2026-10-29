import { BadRequest, NotFound, type PluginConfig } from "@pipoca/plugins";
import type { EnvironmentTemplate } from "@pipoca/protocol";
import type { Log } from "@pipoca/providers";
import { environmentUpdate } from "./requests";

export interface Templates {
  readonly list: () => readonly EnvironmentTemplate[];
  readonly create: (body: unknown) => EnvironmentTemplate;
  readonly update: (id: string, body: unknown) => EnvironmentTemplate;
  readonly remove: (id: string) => void;
}

// Admins keep Environment templates under "templates" in pipoca.json, so a
// Helm value can set them as well as Settings (ADR 0039, ADR 0049). An entry
// that doesn't read is left out and logged, and the others still work.
export function environmentTemplates(
  config: PluginConfig,
  log: Log,
): Templates {
  const list = (): readonly EnvironmentTemplate[] => {
    const value = config.get();
    if (value === undefined) {
      return [];
    }

    if (!Array.isArray(value)) {
      log("templates unreadable", { error: "templates must be a list" });

      return [];
    }

    return value.flatMap((entry: unknown) => {
      try {
        return [templateOf(entry)];
      } catch (error) {
        log("template unreadable", { error: String(error) });

        return [];
      }
    });
  };

  const save = (templates: readonly EnvironmentTemplate[]): void => {
    config.set(templates);
  };

  return {
    list,
    create: (body) => {
      const fields = settingsOf(body);
      if (fields.name === undefined) {
        throw new BadRequest("name is required");
      }

      const taken = new Set(list().map(({ id }) => id));
      const base = slug(fields.name);

      let id = base;
      for (let n = 2; taken.has(id); n++) {
        id = `${base}-${String(n)}`;
      }

      const created: EnvironmentTemplate = {
        id,
        name: fields.name,
        isolation: fields.isolation ?? "process",
        image: fields.image ?? null,
        setupScript: fields.setupScript ?? "",
        variables: fields.variables ?? {},
      };

      save([...list(), created]);

      return created;
    },
    update: (id, body) => {
      const templates = list();
      const template = templates.find((each) => each.id === id);
      if (template === undefined) {
        throw new NotFound(`no template ${id}`);
      }

      const updated = { ...template, ...settingsOf(body) };
      save(templates.map((each) => (each.id === id ? updated : each)));

      return updated;
    },
    remove: (id) => {
      const templates = list();
      if (!templates.some((each) => each.id === id)) {
        throw new NotFound(`no template ${id}`);
      }

      save(templates.filter((each) => each.id !== id));
    },
  };
}

// A template holds no secrets: they belong to each person's Environment.
function settingsOf(body: unknown): Partial<Omit<EnvironmentTemplate, "id">> {
  const { secrets, ...settings } = environmentUpdate(body);
  if (secrets !== undefined) {
    throw new BadRequest("a template holds no secrets");
  }

  return settings;
}

function templateOf(entry: unknown): EnvironmentTemplate {
  const { id } = (entry ?? {}) as { id?: unknown };
  if (typeof id !== "string" || id === "") {
    throw new Error("a template needs an id");
  }

  const fields = settingsOf(entry);

  return {
    id,
    name: fields.name ?? id,
    isolation: fields.isolation ?? "process",
    image: fields.image ?? null,
    setupScript: fields.setupScript ?? "",
    variables: fields.variables ?? {},
  };
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "template"
  );
}
