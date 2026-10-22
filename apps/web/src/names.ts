import type { ModelRef, Session, Workspace } from "@pi-cloud/protocol";

const removalText = {
  pending: "removing workspace",
  forced: "deleting workspace",
  removed: "workspace removed",
  kept: "unpushed work",
} as const;

export function describe(session: Session): string {
  if (session.archivedAt !== null) {
    return session.workspaceRemoval === null
      ? "archived"
      : `archived, ${removalText[session.workspaceRemoval]}`;
  }

  const where = session.online ? "" : ", provider offline";

  return `${session.status}${where}${session.error === null ? "" : `: ${session.error}`}`;
}

export function workspaceName(workspace: Workspace): string {
  switch (workspace.kind) {
    case "folder":
      return workspace.path;
    case "worktree":
      return `${workspace.path} (${workspace.branch})`;
    case "clone":
      return `${workspace.repository} (${workspace.branch})`;
    case "repositories":
      return `${workspace.repositories.map((r) => r.repository).join(", ")} (${workspace.branch})`;
  }
}

export function modelName({ provider, id }: ModelRef): string {
  return `${provider}/${id}`;
}

export function modelRef(name: string): ModelRef | undefined {
  const slash = name.indexOf("/");

  return slash > 0 && slash < name.length - 1
    ? { provider: name.slice(0, slash), id: name.slice(slash + 1) }
    : undefined;
}

export interface SessionBadge {
  readonly state: "working" | "waiting" | "failed" | "offline";
  readonly label: string;
}

// A Session at rest shows no badge, so the ones that need a look stand out.
export function sessionBadge(session: Session): SessionBadge | undefined {
  if (session.archivedAt !== null) {
    return undefined;
  }

  if (!session.online) {
    return { state: "offline", label: "Offline" };
  }

  if (session.waiting) {
    return { state: "waiting", label: "Needs you" };
  }

  switch (session.status) {
    case "queued":
    case "starting":
      return { state: "working", label: "Starting" };
    case "running":
      return { state: "working", label: "Working" };
    case "failed":
      return { state: "failed", label: "Failed" };
    case "interrupted":
      return { state: "offline", label: "Interrupted" };
    case "idle":
    case "stopped":
      return undefined;
  }
}

function lastSegment(path: string): string {
  const parts = path
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .filter((part) => part !== "");

  return parts.at(-1) ?? path;
}

// The few words that name a workspace in a list: its folder or repository.
export function shortName(workspace: Workspace): string {
  switch (workspace.kind) {
    case "folder":
    case "worktree":
      return lastSegment(workspace.path);
    case "clone":
      return lastSegment(workspace.repository);
    case "repositories": {
      const [first, ...rest] = workspace.repositories;
      const name = first ? lastSegment(first.repository) : "repositories";

      return rest.length === 0 ? name : `${name} +${String(rest.length)}`;
    }
  }
}

const units = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
] as const;

export function ago(time: string, now: number): string {
  const elapsed = now - Date.parse(time);
  const unit = units.find(([, ms]) => elapsed >= ms);

  return unit
    ? `${String(Math.floor(elapsed / unit[1]))}${unit[0]} ago`
    : "just now";
}
