import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The product was called Pi Cloud before ADR 0042. Its folder stays where it
// is, since the database and git worktrees hold absolute paths into it.
export function dataFolder(): string {
  const root = join(homedir(), ".pipoca");
  const old = join(homedir(), ".pi-cloud");

  return !existsSync(root) && existsSync(old) ? old : root;
}
