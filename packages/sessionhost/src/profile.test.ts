import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyProfile } from "@pi-cloud/protocol";
import { syncProfile } from "./profile";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "profile-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("writes a Profile as Pi's agent folder and removes what it dropped", async () => {
  const dir = join(root, "profile");

  await syncProfile(
    dir,
    {
      ...emptyProfile,
      agentsMd: "Be brief.",
      systemMd: "You are a reviewer.",
      mcpServers: { docs: { url: "https://example.com/mcp" } },
      settings: { defaultThinkingLevel: "high" },
    },
    () => undefined,
  );

  expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("Be brief.");

  expect(
    JSON.parse(await readFile(join(dir, "settings.json"), "utf8")),
  ).toEqual({ defaultThinkingLevel: "high", packages: [] });

  expect(JSON.parse(await readFile(join(dir, "mcp.json"), "utf8"))).toEqual({
    mcpServers: { docs: { url: "https://example.com/mcp" } },
  });

  await syncProfile(
    dir,
    { ...emptyProfile, agentsMd: "Be brief." },
    () => undefined,
  );

  const files = await readdir(dir);

  expect(files).toContain("AGENTS.md");
  expect(files).not.toContain("SYSTEM.md");
  expect(files).not.toContain("mcp.json");
});

test("installs a Profile's packages once, and again only after a failure", async () => {
  const dir = join(root, "profile");
  const kit = join(root, "kit");
  const installs: unknown[] = [];

  const log = (message: string, fields?: Record<string, unknown>): void => {
    if (message === "installing profile package") {
      installs.push(fields?.["source"]);
    }
  };

  const profile = { ...emptyProfile, packages: [kit] };

  expect(syncProfile(dir, profile, log)).rejects.toThrow(
    `package ${kit} failed to install`,
  );

  await mkdir(kit);
  await syncProfile(dir, profile, log);
  await syncProfile(dir, profile, log);

  expect(installs).toEqual([kit, kit]);

  expect(
    JSON.parse(await readFile(join(dir, "settings.json"), "utf8")),
  ).toEqual({ packages: [kit] });
});
