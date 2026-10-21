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

export function validName(name: string): boolean {
  return name.length <= 200 && /^[\w.-][\w .-]*$/.test(name);
}
