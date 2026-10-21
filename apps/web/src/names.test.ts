import { expect, test } from "bun:test";
import type { Session } from "@pi-cloud/protocol";
import { sessionBadge } from "./names";

const session = (change: Partial<Session>): Session => ({
  id: "s",
  environmentId: "e",
  ownerId: "o",
  provider: "laptop",
  workspace: { kind: "folder", path: "/repo" },
  model: null,
  systemPrompt: null,
  firstMessage: null,
  status: "idle",
  generation: 1,
  createdAt: "2026-10-21T00:00:00Z",
  interruptedAt: null,
  error: null,
  archivedAt: null,
  workspaceRemoval: null,
  online: true,
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
});
