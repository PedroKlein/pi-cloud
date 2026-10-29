import type {
  PluginSettings,
  SettingSpec,
  SettingValue,
} from "@pipoca/protocol";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { isObject } from "./http";

type Schema = Readonly<Record<string, SettingSpec>>;

const described = {
  title: Type.String(),
  description: Type.Optional(Type.String()),
};

const settingSpec = Type.Union([
  Type.Object({
    ...described,
    type: Type.Literal("string"),
    default: Type.String(),
  }),
  Type.Object({
    ...described,
    type: Type.Literal("number"),
    default: Type.Number(),
    min: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
  }),
  Type.Object({
    ...described,
    type: Type.Literal("boolean"),
    default: Type.Boolean(),
  }),
  Type.Object({
    ...described,
    type: Type.Literal("choice"),
    options: Type.Array(Type.String()),
    default: Type.String(),
  }),
  Type.Object({
    ...described,
    type: Type.Literal("strings"),
    default: Type.Array(Type.String()),
  }),
]);

// A plugin's values with a default for every setting it declares. Stored
// values that no longer fit the schema read as their defaults, and names it
// no longer declares are left out (ADR 0036).
export function settingValues(
  schema: Schema | undefined,
  stored: unknown,
): PluginSettings {
  const given = isObject(stored) ? stored : {};

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
  if (!isObject(body)) {
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
  if (!isObject(settings)) {
    throw new Error("pipoca.settings must name each setting the plugin has");
  }

  return Object.fromEntries(
    Object.entries(settings).map(([name, spec]) => {
      if (!Value.Check(settingSpec, spec) || !fits(spec, spec.default)) {
        throw new Error(
          `pipoca.settings.${name} needs a title, a type this server knows and a default that fits it`,
        );
      }

      return [name, spec];
    }),
  );
}

function fits(spec: SettingSpec, value: unknown): value is SettingValue {
  return Value.Check(valueSchema(spec), value);
}

// The JSON Schema of a setting's value.
function valueSchema(spec: SettingSpec): TSchema {
  switch (spec.type) {
    case "string":
      return Type.String();
    case "number":
      return Type.Number({
        ...(spec.min !== undefined && { minimum: spec.min }),
        ...(spec.max !== undefined && { maximum: spec.max }),
      });
    case "boolean":
      return Type.Boolean();
    case "choice":
      return Type.Enum(spec.options);
    case "strings":
      return Type.Array(Type.String());
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
