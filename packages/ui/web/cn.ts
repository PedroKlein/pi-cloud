export function cn(
  ...classes: readonly (string | false | undefined)[]
): string {
  return classes.filter((name) => typeof name === "string").join(" ");
}
