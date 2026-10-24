import { relative, sep } from "node:path";
import type { ModelRef } from "@pi-cloud/protocol";
import type { PolledRunner } from "./runner-polls";
import type { StoredSession } from "./sessions";

// A Session that ran on a runner goes back to it. A new Session in a folder
// of the runner's machine goes to a runner that lists the folder, while one is
// online, and any other Session goes to the first runner with room
// (ADR 0032).
export function placesOn(
  session: StoredSession,
  runner: string,
  pool: readonly PolledRunner[],
): boolean {
  if (session.runner !== null) {
    return session.runner === runner;
  }

  const { workspace } = session;
  if (workspace.kind !== "folder" && workspace.kind !== "worktree") {
    return true;
  }

  const lists = ({ inventory }: PolledRunner): boolean =>
    inventory.folders.some((folder) => inside(folder, workspace.path));

  const self = pool.find(({ name }) => name === runner);

  return (
    (self !== undefined && lists(self)) ||
    !pool.some((each) => each.online && lists(each))
  );
}

function inside(root: string, folder: string): boolean {
  const fromRoot = relative(root, folder);

  return (
    fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
  );
}

export function uniqueModels(models: readonly ModelRef[]): ModelRef[] {
  const seen = new Set<string>();

  return models.filter(({ provider, id }) => {
    const key = `${provider}/${id}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}
