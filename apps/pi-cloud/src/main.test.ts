import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import type { Environment, Session, SessionEvent } from "@pi-cloud/protocol";
import { readSse } from "./sse";

test("shuts down cleanly on SIGTERM when another library also handles it", async () => {
  const server = spawn(
    process.execPath,
    [
      "--preload",
      join(import.meta.dirname, "testdata", "late-signal-exit.ts"),
      join(import.meta.dirname, "main.ts"),
      "server",
      "--port",
      "0",
      "--database",
      ":memory:",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let log = "";
  server.stderr.setEncoding("utf8");

  await new Promise<void>((resolve) => {
    server.stderr.on("data", (chunk: string) => {
      log += chunk;
      if (
        log.includes("server listening") &&
        log.includes("signal-exit copy loaded")
      ) {
        resolve();
      }
    });
  });

  server.kill("SIGTERM");

  const [code, signal] = (await once(server, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];

  expect({ code, signal }).toEqual({ code: 0, signal: null });
  expect(log).toContain("server stopped");
});

test("refuses to start an agent with a folder that does not exist", async () => {
  const agent = spawn(
    process.execPath,
    [
      join(import.meta.dirname, "main.ts"),
      "agent",
      "--name",
      "laptop",
      "--server",
      "http://127.0.0.1:9",
      "--folder",
      "/no/such/folder",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let log = "";
  agent.stderr.setEncoding("utf8");

  agent.stderr.on("data", (chunk: string) => {
    log += chunk;
  });

  const [code] = (await once(agent, "exit")) as [number | null];

  expect(code).toBe(2);
  expect(log).toContain("folder does not exist: /no/such/folder");
});

test("marks a session failed and keeps running when its process cannot be spawned", async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "pi-cloud-")));

  const server = spawn(
    process.execPath,
    [
      "--preload",
      join(import.meta.dirname, "testdata", "missing-session-binary.ts"),
      join(import.meta.dirname, "main.ts"),
      "server",
      "--port",
      "0",
      "--database",
      ":memory:",
      "--provider",
      "laptop",
      "--data-dir",
      join(folder, ".pi-cloud"),
      "--folder",
      folder,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PI_CODING_AGENT_DIR: join(folder, ".pi") },
    },
  );

  const controller = new AbortController();

  try {
    const url = await new Promise<string>((resolve) => {
      createInterface({ input: server.stderr }).on("line", (line) => {
        if (line.includes("server listening")) {
          resolve((JSON.parse(line) as { url: string }).url);
        }
      });
    });

    let environment: Environment | undefined;
    while (environment === undefined) {
      const response = await fetch(new URL("/api/environments", url));

      environment = ((await response.json()) as Environment[]).find(
        (each) => each.provider === "laptop",
      );

      await sleep(20);
    }

    const created = await fetch(new URL("/api/sessions", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environment: environment.id,
        workspace: { kind: "folder", path: folder },
      }),
    });

    const { id } = (await created.json()) as Session;

    const stream = await fetch(new URL(`/api/sessions/${id}/events`, url), {
      signal: controller.signal,
    });

    let failed: Session | undefined;
    for await (const event of readSse(stream) as AsyncGenerator<SessionEvent>) {
      if (event.type === "session" && event.session.status === "failed") {
        failed = event.session;
        break;
      }
    }

    expect(failed?.error).toContain("ENOENT");

    controller.abort();
    server.kill("SIGTERM");
    const [code] = (await once(server, "exit")) as [number | null];

    expect(code).toBe(0);
  } finally {
    controller.abort();
    server.kill("SIGKILL");
    await rm(folder, { recursive: true, force: true });
  }
}, 30_000);
