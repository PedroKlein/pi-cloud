import { expect, test } from "bun:test";
import type { Session } from "@pi-cloud/protocol";
import { ago, sessionBadge, shortName } from "./names";

const session = (change: Partial<Session>): Session => ({
  id: "s",
  environmentId: "e",
  ownerId: "o",
  provider: "laptop",
  workspace: { kind: "folder", path: "/repo" },
  model: null,
  thinking: null,
  systemPrompt: null,
  firstMessage: null,
  title: null,
  status: "idle",
  generation: 1,
  createdAt: "2026-10-21T00:00:00Z",
  interruptedAt: null,
  error: null,
  archivedAt: null,
  workspaceRemoval: null,
  workspaceKeptReason: null,
  online: true,
  waiting: false,
  ...change,
});

test("a session at rest shows no badge", () => {
  expect(sessionBadge(session({ status: "idle" }))).toBeUndefined();

  expect(
    sessionBadge(session({ archivedAt: "2026-10-21T00:00:00Z" })),
  ).toBeUndefined();
});

test("a session that needs a look shows its state", () => {
  expect(sessionBadge(session({ status: "running" }))).toEqual({
    state: "working",
    label: "Working",
  });

  expect(sessionBadge(session({ status: "failed" }))).toEqual({
    state: "failed",
    label: "Failed",
  });

  expect(sessionBadge(session({ status: "running", online: false }))).toEqual({
    state: "offline",
    label: "Offline",
  });

  expect(sessionBadge(session({ status: "running", waiting: true }))).toEqual({
    state: "waiting",
    label: "Needs you",
  });
});

test("names a workspace by its folder or repository", () => {
  expect(shortName({ kind: "folder", path: "/home/me/pi-cloud" })).toBe(
    "pi-cloud",
  );

  expect(
    shortName({
      kind: "clone",
      repository: "git@github.com:me/site.git",
      branch: "b",
      startPoint: "",
    }),
  ).toBe("site");

  expect(
    shortName({
      kind: "repositories",
      branch: "b",
      repositories: [
        { repository: "https://github.com/me/api", startPoint: "" },
        { repository: "https://github.com/me/web", startPoint: "" },
      ],
    }),
  ).toBe("api +1");
});

test("says how long ago something happened", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");

  expect(ago("2026-10-21T11:59:30Z", now)).toBe("just now");
  expect(ago("2026-10-21T11:15:00Z", now)).toBe("45m ago");
  expect(ago("2026-10-21T09:00:00Z", now)).toBe("3h ago");
  expect(ago("2026-10-19T12:00:00Z", now)).toBe("2d ago");
});
