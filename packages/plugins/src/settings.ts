import type {
  PluginSettings,
  SettingSpec,
  SettingValue,
} from "@pipoca/protocol";

type Schema = Readonly<Record<string, SettingSpec>>;

// A plugin's values with a default for every setting it declares. Stored
// values that no longer fit the schema read as their defaults, and names it
// no longer declares are left out (ADR 0036).
export function settingValues(
  schema: Schema | undefined,
  stored: unknown,
): PluginSettings {
  const given = isRecord(stored) ? stored : {};

  return Object.fromEntries(
    Object.entries(schema ?? {}).map(([name, spec]) => {
      const value = given[name];

      return [name, fits(spec, value) ? value : spec.default];
    }),
  );
}

// The values to save from a request body, or what is wrong with it. A
// setting the body leaves out takes its default.
export function checkedSettings(
  schema: Schema | undefined,
  body: unknown,
): PluginSettings | string {
  if (!isRecord(body)) {
    return "settings must be an object";
  }

  for (const [name, spec] of Object.entries(schema ?? {})) {
    const value = body[name];

    if (value !== undefined && !fits(spec, value)) {
      return `${spec.title} ${rule(spec)}`;
    }
  }

  return settingValues(schema, body);
}

// The settings a plugin's manifest declares, or throws with what is wrong
// with them.
export function settingSpecs(settings: unknown): Schema {
  if (!isRecord(settings)) {
    throw new Error("pipoca.settings must name each setting the plugin has");
  }

  for (const [name, spec] of Object.entries(settings)) {
    if (!isSpec(spec)) {
      throw new Error(
        `pipoca.settings.${name} needs a title, a type this server knows and a default that fits it`,
      );
    }
  }

  return settings as Schema;
}

const types: readonly unknown[] = [
  "string",
  "number",
  "boolean",
  "choice",
  "strings",
] satisfies readonly SettingSpec["type"][];

function isSpec(spec: unknown): spec is SettingSpec {
  if (!isRecord(spec)) {
    return false;
  }

  const { title, description, type, min, max, options } = spec;

  if (
    typeof title !== "string" ||
    (description !== undefined && typeof description !== "string") ||
    !types.includes(type)
  ) {
    return false;
  }

  if (
    type === "number" &&
    ![min, max].every(
      (bound) =>
        bound === undefined ||
        (typeof bound === "number" && Number.isFinite(bound)),
    )
  ) {
    return false;
  }

  if (
    type === "choice" &&
    !(
      Array.isArray(options) &&
      options.every((option) => typeof option === "string")
    )
  ) {
    return false;
  }

  return fits(spec as unknown as SettingSpec, spec["default"]);
}

function fits(spec: SettingSpec, value: unknown): value is SettingValue {
  switch (spec.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= (spec.min ?? -Infinity) &&
        value <= (spec.max ?? Infinity)
      );
    case "boolean":
      return typeof value === "boolean";
    case "choice":
      return typeof value === "string" && spec.options.includes(value);
    case "strings":
      return (
        Array.isArray(value) && value.every((each) => typeof each === "string")
      );
  }
}

function rule(spec: SettingSpec): string {
  switch (spec.type) {
    case "string":
      return "must be text";
    case "number":
      return [
        "must be a number",
        ...(spec.min === undefined ? [] : [`at least ${String(spec.min)}`]),
        ...(spec.max === undefined ? [] : [`at most ${String(spec.max)}`]),
      ].join(", ");
    case "boolean":
      return "must be true or false";
    case "choice":
      return `must be one of ${spec.options.join(", ")}`;
    case "strings":
      return "must be a list of text";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
