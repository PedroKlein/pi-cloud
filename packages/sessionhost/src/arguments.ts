interface Schema {
  readonly type?: unknown;
  readonly enum?: unknown;
  readonly const?: unknown;
  readonly anyOf?: unknown;
  readonly oneOf?: unknown;
  readonly properties?: unknown;
}

// Models sometimes send a value JSON-encoded, such as "\"done\"" for an enum
// or "[\"a\"]" for an array, and Pi's validator only turns strings into
// numbers and booleans (ADR 0038).
export function repairArguments(
  args: unknown,
  schema: Readonly<Record<string, unknown>>,
): unknown {
  const properties = propertiesOf(schema);
  if (!isRecord(args) || properties === undefined) {
    return args;
  }

  let repaired: Record<string, unknown> | undefined;

  for (const [name, property] of Object.entries(properties)) {
    const value = args[name];
    if (typeof value !== "string" || fits(value, property)) {
      continue;
    }

    const parsed = parseJson(value);
    if (parsed !== undefined && fits(parsed, property)) {
      repaired ??= { ...args };
      repaired[name] = parsed;
    }
  }

  const result = repaired ?? args;
  refuseUnknownChoices(result, properties);

  return result;
}

// Pi's own message for a wrong enum doesn't say what is allowed, so a model
// tends to send the same value again.
function refuseUnknownChoices(
  args: Record<string, unknown>,
  properties: Readonly<Record<string, Schema>>,
): void {
  for (const [name, property] of Object.entries(properties)) {
    const choices = property.enum;
    const value = args[name];

    if (
      Array.isArray(choices) &&
      value !== undefined &&
      !choices.includes(value)
    ) {
      throw new Error(
        `${name} must be one of ${choices.map((choice) => JSON.stringify(choice)).join(", ")}, not ${JSON.stringify(value)}`,
      );
    }
  }
}

function fits(value: unknown, schema: Schema): boolean {
  if (Array.isArray(schema.enum)) {
    return schema.enum.includes(value);
  }

  if ("const" in schema) {
    return schema.const === value;
  }

  const members = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(members)) {
    return members.some((member) => isRecord(member) && fits(value, member));
  }

  const types = [schema.type].flat().filter((type) => type !== undefined);

  return types.length === 0 || types.some((type) => hasType(value, type));
}

function hasType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "integer":
      return Number.isInteger(value);
    case "null":
      return value === null;
    default:
      return typeof value === type;
  }
}

function propertiesOf(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, Schema>> | undefined {
  const { properties } = schema as Schema;

  return isRecord(properties)
    ? (properties as Readonly<Record<string, Schema>>)
    : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
