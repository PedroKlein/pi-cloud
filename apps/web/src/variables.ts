// One NAME=value per line, as in a .env file.
export function variablesText(
  variables: Readonly<Record<string, string>>,
): string {
  return Object.entries(variables)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}

export function variablesOf(text: string): Record<string, string> {
  const variables: Record<string, string> = {};

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }

    const equals = line.indexOf("=");
    if (equals <= 0) {
      throw new Error(`"${line.trim()}" isn't NAME=value.`);
    }

    const name = line.slice(0, equals).trim();
    if (name in variables) {
      throw new Error(`${name} is set twice.`);
    }

    variables[name] = line.slice(equals + 1);
  }

  return variables;
}
