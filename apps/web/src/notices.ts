import type { Session, SessionStatus } from "@pi-cloud/protocol";
import { shortName } from "./names";

const busy: readonly SessionStatus[] = ["queued", "starting", "running"];

// Sessions that were busy in the last poll and have stopped since, or have
// started waiting on an answer. A session that only started and went idle
// has done no work, so it has not finished anything.
export function settled(
  previous: readonly Session[],
  current: readonly Session[],
): readonly Session[] {
  const before = new Map(previous.map((session) => [session.id, session]));

  return current.filter((session) => {
    const was = before.get(session.id);

    if (was === undefined) {
      return false;
    }

    const stopped =
      busy.includes(was.status) &&
      !busy.includes(session.status) &&
      (was.status === "running" || session.status !== "idle");

    return stopped || (!was.waiting && session.waiting);
  });
}

export function noticeText(session: Session): string {
  const place = shortName(session.workspace);

  if (session.waiting) {
    return `Pi needs you in ${place}`;
  }

  switch (session.status) {
    case "failed":
      return `Pi failed in ${place}`;
    case "interrupted":
      return `Pi was interrupted in ${place}`;
    case "stopped":
      return `Pi stopped in ${place}`;
    case "queued":
    case "starting":
    case "running":
    case "idle":
      return `Pi finished in ${place}`;
  }
}

// Matches a session against what someone typed in the sessions search box.
export function matches(
  session: Session,
  query: string,
  environmentName: string,
): boolean {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");

  const text = [
    session.title ?? "",
    shortName(session.workspace),
    ...values(session.workspace),
    environmentName,
    session.model?.id ?? "",
  ]
    .join(" ")
    .toLowerCase();

  return words.every((word) => text.includes(word));
}

function values(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }

  return typeof value === "object" && value !== null
    ? Object.values(value).flatMap(values)
    : [];
}
