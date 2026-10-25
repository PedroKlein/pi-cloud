import { relative, sep } from "node:path";
import { type ModelRef, movable } from "@pi-cloud/protocol";
import type { PolledRunner } from "./runner-polls";
import type { StoredSession } from "./sessions";

// A Session that ran on a runner goes back to it, unless that runner's lease
// lapsed and the Session's Workspace can be made again elsewhere. A new
// Session in a folder of the runner's machine goes to a runner that lists the
// folder, while one is online, and any other Session goes to the first runner
// with room (ADR 0032).
export function placesOn(
  session: StoredSession,
  runner: string,
  pool: {
    readonly runners: readonly PolledRunner[];
    readonly leaseLapsed: (runner: string) => boolean;
  },
): boolean {
  if (session.runner !== null) {
    return (
      session.runner === runner ||
      (movable(session.workspace) && pool.leaseLapsed(session.runner))
    );
  }

  const { workspace } = session;
  const self = pool.runners.find(({ name }) => name === runner);

  return (
    ((workspace.kind === "folder" || workspace.kind === "worktree") &&
      self !== undefined &&
      lists(self, workspace.path)) ||
    placesOnNewRunner(session, pool)
  );
}

// Whether a runner that hasn't joined the pool yet, and so lists no folder,
// could take a Session that hasn't run.
export function placesOnNewRunner(
  { workspace }: StoredSession,
  pool: { readonly runners: readonly PolledRunner[] },
): boolean {
  return (
    (workspace.kind !== "folder" && workspace.kind !== "worktree") ||
    !pool.runners.some((each) => each.online && lists(each, workspace.path))
  );
}

function lists({ inventory }: PolledRunner, path: string): boolean {
  return inventory.folders.some((folder) => inside(folder, path));
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
