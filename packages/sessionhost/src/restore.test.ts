import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreTranscript } from "./index";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sessionhost-restore-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const header = JSON.stringify({ type: "session", id: "s1", cwd: "/old" });

const entry = (text: string): string =>
  JSON.stringify({ type: "message", text });

async function transcripts(dir: string): Promise<string[][]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".jsonl"));

  return Promise.all(
    files.map(async (file) =>
      (await readFile(join(dir, file), "utf8")).trim().split("\n"),
    ),
  );
}

test("starts from the server's newer transcript when told to start fresh over a stale copy", async () => {
  const sessionDir = join(root, "sessions", "s1");
  await mkdir(join(sessionDir, "gh"), { recursive: true });
  await writeFile(join(sessionDir, "gh", "hosts.yml"), "stale\n");

  await writeFile(
    join(sessionDir, "earlier.jsonl"),
    `${[header, entry("one")].join("\n")}\n`,
  );

  const server = [header, entry("one"), entry("two"), entry("three")];

  const restored = await restoreTranscript(
    sessionDir,
    "/new",
    async () => Promise.resolve(server),
    { fresh: true },
  );

  expect(restored).toBe(4);
  expect(await readdir(sessionDir)).toEqual(["restored_s1.jsonl"]);

  expect(await transcripts(sessionDir)).toEqual([
    [
      JSON.stringify({ type: "session", id: "s1", cwd: "/new" }),
      entry("one"),
      entry("two"),
      entry("three"),
    ],
  ]);
});

test("keeps its own copy when the Session last ran here", async () => {
  const sessionDir = join(root, "sessions", "s1");
  await mkdir(sessionDir, { recursive: true });

  await writeFile(
    join(sessionDir, "earlier.jsonl"),
    `${[header, entry("one")].join("\n")}\n`,
  );

  const restored = await restoreTranscript(sessionDir, "/new", async () =>
    Promise.resolve([header, entry("one"), entry("two")]),
  );

  expect(restored).toBe(0);
  expect(await transcripts(sessionDir)).toEqual([[header, entry("one")]]);
});
