import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

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
