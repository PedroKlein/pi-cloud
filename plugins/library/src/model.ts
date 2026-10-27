import type { PluginSettings } from "@pipoca/protocol";

export interface LibraryFile {
  readonly name: string;
  readonly size: number;
  readonly actor: string;
  readonly updatedAt: string;
}

export interface LibraryWrite {
  readonly name: string;
  readonly size: number;
  readonly actor: string;
  readonly at: string;
}

export const nameRule =
  "file names can't be empty, longer than 200 characters or only dots, can't start or end with whitespace, and can't contain /, \\, control characters or text direction controls";

// The fileLimitMb setting from the plugin's manifest, in bytes.
export function fileLimit(settings: PluginSettings): number {
  const megabytes = settings["fileLimitMb"];
  if (typeof megabytes !== "number") {
    throw new Error("library settings have no fileLimitMb");
  }

  return megabytes * 1024 * 1024;
}

export function sizeRule(limit: number): string {
  return `library files are limited to ${String(limit / 1024 / 1024)} MB`;
}

// Direction controls can make "photo\u202Egnp.exe" display as "photoexe.png".
export function validName(name: string): boolean {
  return (
    name !== "" &&
    name.length <= 200 &&
    !/^\.+$/.test(name) &&
    !/^\s|\s$/u.test(name) &&
    !/[/\\\p{Cc}\p{Bidi_Control}]/u.test(name)
  );
}
