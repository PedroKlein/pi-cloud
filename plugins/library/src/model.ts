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

export const nameRule = "file names may use letters, digits, spaces, . _ and -";

export function validName(name: string): boolean {
  return (
    name.length <= 200 &&
    /^[\p{L}\d_.-][\p{L}\p{M}\d_ .-]*$/u.test(name) &&
    !/^\.+$/.test(name)
  );
}
