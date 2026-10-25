import type {
  PluginSettings,
  SettingSpec,
  SettingValue,
} from "@pi-cloud/protocol";

// The values a plugin's settings form holds, by the types its schema gives.
// A list of text takes one entry per line.
export function settingsOf(
  schema: Readonly<Record<string, SettingSpec>>,
  form: FormData,
): PluginSettings {
  return Object.fromEntries(
    Object.entries(schema).map(([name, spec]): [string, SettingValue] => {
      const entry = form.get(name);
      const text = typeof entry === "string" ? entry : "";

      switch (spec.type) {
        case "number":
          return [name, Number(text)];
        case "boolean":
          return [name, entry !== null];
        case "strings":
          return [
            name,
            text
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line !== ""),
          ];
        case "string":
        case "choice":
          return [name, text];
      }
    }),
  );
}
