import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentSetup } from "./setup";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "setup-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("masks the Environment's secrets but not git's helpers in a failed setup's output and log", async () => {
  const setUp = environmentSetup(
    dir,
    () => undefined,
    new AbortController().signal,
  );

  const failure = await setUp(
    {
      isolation: "process",
      image: null,
      setupScript:
        'echo "line 12 of $GIT_CONFIG_COUNT in $GIT_CONFIG_KEY_0 with $GH_TOKEN and $PIN"; exit 3',
      variables: { GH_TOKEN: "ghp_0123456789abcdefghij", PIN: "s3c" },
    },
    {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );

  const [version = ""] = await readdir(dir);
  const output = await readFile(join(dir, version, "output.log"), "utf8");

  const shown =
    "line 12 of 2 in credential.https://github.com.helper with *** and ***";

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(shown);
  expect(output).toBe(`${shown}\n`);
});
