import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileFiles } from "@pi-cloud/protocol";
import { syncProfile } from "./profile";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "profile-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function profileOf(
  hash: string,
  files: Record<string, string>,
): () => Promise<ProfileFiles> {
  return async () =>
    Promise.resolve({
      hash,
      files: Object.fromEntries(
        Object.entries(files).map(([path, text]) => [
          path,
          Buffer.from(text).toString("base64"),
        ]),
      ),
    });
}

const quiet = (): void => undefined;

async function failure(sync: Promise<void>): Promise<string> {
  return sync.then(
    () => "",
    (error: unknown) => String(error),
  );
}

test("writes a Profile's files and removes what it dropped", async () => {
  const dir = join(root, "profile");

  await syncProfile(
    dir,
    "h1",
    profileOf("h1", {
      "AGENTS.md": "Be brief.",
      "SYSTEM.md": "You are a reviewer.",
      "skills/review/SKILL.md": "# Review",
    }),
    quiet,
  );

  expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("Be brief.");

  expect(await readFile(join(dir, "skills/review/SKILL.md"), "utf8")).toBe(
    "# Review",
  );

  await syncProfile(
    dir,
    "h2",
    profileOf("h2", { "AGENTS.md": "Be thorough." }),
    quiet,
  );

  expect(await readdir(dir)).not.toContain("SYSTEM.md");
  expect(await readdir(join(dir, "skills/review"))).toEqual([]);
  expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("Be thorough.");
});

test("downloads a Profile only when its hash changed", async () => {
  const dir = join(root, "profile");
  let downloads = 0;

  const download = async (): Promise<ProfileFiles> => {
    downloads++;

    return profileOf("h1", { "AGENTS.md": "Be brief." })();
  };

  await syncProfile(dir, "h1", download, quiet);
  await syncProfile(dir, "h1", download, quiet);

  expect(downloads).toBe(1);
});

test("refuses a file outside the Profile's folder", async () => {
  const dir = join(root, "profile");

  expect(
    await failure(
      syncProfile(dir, "h1", profileOf("h1", { "../escape": "x" }), quiet),
    ),
  ).toContain("outside its folder");
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

  const settings = JSON.stringify({ packages: [kit] });

  expect(
    await failure(
      syncProfile(
        dir,
        "h1",
        profileOf("h1", { "settings.json": settings }),
        log,
      ),
    ),
  ).toContain(`package ${kit} failed to install`);

  expect(await readdir(dir).catch(() => [])).not.toContain("settings.json");

  await mkdir(kit);

  for (const hash of ["h1", "h2"]) {
    await syncProfile(
      dir,
      hash,
      profileOf(hash, { "settings.json": settings }),
      log,
    );
  }

  expect(installs).toEqual([kit, kit]);

  expect(
    JSON.parse(await readFile(join(dir, "settings.json"), "utf8")),
  ).toEqual({ packages: [kit] });
});
