import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
let root: string;
let binary: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-cloud-build-"));
  binary = join(root, "pi-cloud");

  await run(process.execPath, ["src/build.ts", "--outfile", binary], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// A compiled binary has no Pi package.json beside it, where Pi reads its version.
test("a compiled server reports the version of Pi it bundles", async () => {
  const pi = JSON.parse(
    await readFile(
      fileURLToPath(
        import.meta.resolve("@earendil-works/pi-coding-agent/package.json"),
      ),
      "utf8",
    ),
  ) as { version: string };

  const server = spawn(
    binary,
    ["server", "--port", "0", "--database", ":memory:"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  try {
    const url = await new Promise<string>((resolve) => {
      createInterface({ input: server.stderr }).on("line", (line) => {
        if (line.includes("server listening")) {
          resolve((JSON.parse(line) as { url: string }).url);
        }
      });
    });

    const health = await fetch(new URL("/healthz", url));

    expect(await health.json()).toMatchObject({ pi: pi.version });
  } finally {
    server.kill("SIGTERM");
  }
}, 30_000);
