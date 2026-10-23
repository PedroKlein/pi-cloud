import { expect, test } from "bun:test";
import type { Session } from "@pi-cloud/protocol";
import { matches, noticeText, settled } from "./notices";

const session = (change: Partial<Session>): Session => ({
  id: "s",
  environmentId: "e",
  ownerId: "o",
  provider: "laptop",
  workspace: { kind: "folder", path: "/home/me/site" },
  model: { provider: "github-copilot", id: "gpt-5.3-codex" },
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

test("only sessions that stop working have settled", () => {
  const before = [
    session({ id: "a", status: "running" }),
    session({ id: "b", status: "idle" }),
    session({ id: "c", status: "starting" }),
  ];

  const after = [
    session({ id: "a", status: "idle" }),
    session({ id: "b", status: "idle" }),
    session({ id: "c", status: "running" }),
    session({ id: "d", status: "idle" }),
  ];

  expect(settled(before, after).map(({ id }) => id)).toEqual(["a"]);
});

test("a session that starts waiting on an answer gets a notice", () => {
  const before = [
    session({ id: "a", status: "running" }),
    session({ id: "b", status: "running", waiting: true }),
  ];

  const after = [
    session({ id: "a", status: "running", waiting: true }),
    session({ id: "b", status: "running", waiting: true }),
  ];

  expect(settled(before, after).map(({ id }) => id)).toEqual(["a"]);

  expect(noticeText(session({ status: "running", waiting: true }))).toBe(
    "Pi needs you in site",
  );
});

test("a notice says how the session ended and where", () => {
  expect(noticeText(session({ status: "idle" }))).toBe("Pi finished in site");
  expect(noticeText(session({ status: "failed" }))).toBe("Pi failed in site");
});

test("search matches every word against name, path, environment and model", () => {
  const found = session({});

  expect(matches(found, "site laptop", "laptop")).toBe(true);
  expect(matches(found, "HOME/ME codex", "laptop")).toBe(true);
  expect(matches(found, "site vm", "laptop")).toBe(false);
  expect(matches(found, "  ", "laptop")).toBe(true);
});

test("search matches the session's title", () => {
  const titled = session({ title: "Fix the login redirect" });

  expect(matches(titled, "login", "laptop")).toBe(true);
  expect(matches(session({}), "login", "laptop")).toBe(false);
});
