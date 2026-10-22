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

export const fileLimit = 10 * 1024 * 1024;

export const nameRule =
  "file names can't be empty, longer than 200 characters or only dots, can't start or end with whitespace, and can't contain /, \\, control characters or text direction controls";

export const sizeRule = `library files are limited to ${String(fileLimit / 1024 / 1024)} MB`;

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
