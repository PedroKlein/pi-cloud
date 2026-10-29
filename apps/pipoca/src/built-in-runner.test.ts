import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serve } from "./serve";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "built-in-runner-"));
  process.env["KUBERNETES_SERVICE_HOST"] = "10.0.0.1";
  process.env["PIPOCA_RUNNER_URL"] = "http://pipoca.pipoca.svc:7420";
});

afterEach(async () => {
  delete process.env["KUBERNETES_SERVICE_HOST"];
  delete process.env["PIPOCA_RUNNER_URL"];
  await rm(root, { recursive: true, force: true });
});

test("runs no runner of its own where it starts runner pods (ADR 0049)", async () => {
  const logs: string[] = [];

  const server = serve({
    port: 0,
    database: join(root, "server.db"),
    configDir: join(root, "config"),
    agent: {
      provider: "server",
      dataDir: join(root, "server"),
      extensionPaths: [],
      folders: [],
    },
    log: (message) => {
      logs.push(message);
    },
  });

  await server.stop();

  expect(logs).toContain(
    "the server's own runner is off, since it starts runner pods in its cluster",
  );

  const db = new DatabaseSync(join(root, "server.db"));
  const environments = db.prepare("select provider from environments").all();
  db.close();

  expect(environments).toEqual([]);
});
