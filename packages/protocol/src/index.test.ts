import { expect, test } from "bun:test";
import { type Assignment, checkoutName, loggedStart } from "./index";

test("names a checkout after the last segment of its URL", () => {
  expect(checkoutName("https://github.com/org/app.git")).toBe("app");
  expect(checkoutName("git@github.com:org/app.git")).toBe("app");
  expect(checkoutName("/home/me/app/")).toBe("app");
  expect(checkoutName("C:\\code\\app")).toBe("app");
});

test("gives no name to a URL whose last segment can't be a folder", () => {
  expect(checkoutName("/home/me/app/.git")).toBeUndefined();
  expect(checkoutName("/home/me/app/.git/")).toBeUndefined();
  expect(checkoutName("https://example.com/org/.")).toBeUndefined();
  expect(checkoutName("https://example.com/org/..")).toBeUndefined();
  expect(checkoutName("https://example.com/org/..git")).toBeUndefined();
});

test("logs a Session's start without its messages, settings or URL credentials", () => {
  const start: Assignment & { readonly token: string } = {
    sessionId: "s1",
    generation: 2,
    profile: { id: "work", hash: "abc" },
    workspace: {
      kind: "repositories",
      branch: "pipoca/s1",
      repositories: [
        { repository: "https://me:secret@example.com/org/app.git" },
        { repository: "git@example.com:org/tool.git" },
      ],
    },
    trusted: true,
    model: { provider: "anthropic", id: "claude" },
    thinking: "high",
    systemPrompt: "private prompt",
    firstMessage: "private message",
    plugins: ["changes"],
    pluginSettings: { changes: { apiKey: "secret" } },
    environment: {
      isolation: "process",
      image: null,
      setupScript: "",
      variables: { TOKEN: "secret" },
    },
    gitLogins: [{ host: "example.com", token: "secret" }],
    token: "secret",
  };

  const logged = loggedStart(start);

  expect(logged).toEqual({
    sessionId: "s1",
    generation: 2,
    profile: { id: "work", hash: "abc" },
    model: { provider: "anthropic", id: "claude" },
    thinking: "high",
    plugins: ["changes"],
    workspace: {
      kind: "repositories",
      branch: "pipoca/s1",
      repositories: [
        "https://example.com/org/app.git",
        "git@example.com:org/tool.git",
      ],
    },
  });

  expect(JSON.stringify(logged)).not.toContain("secret");
  expect(JSON.stringify(logged)).not.toContain("private");
});
