import { expect, test } from "bun:test";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
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

test.each(["server", "agent"] as const)(
  "resolves a relative data dir and extension against where the %s was started",
  async (command) => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-cloud-")));
    const repository = join(cwd, "repository");
    await gitRepository(repository);
    await writeFile(join(cwd, "proxy.ts"), proxyExtension);

    const main = join(import.meta.dirname, "main.ts");

    const options = {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(cwd, ".pi") },
    };

    const relativePaths = [
      "--data-dir",
      "data",
      "--extension",
      "./proxy.ts",
      "--folder",
      repository,
    ];

    const server = spawn(
      process.execPath,
      [
        main,
        "server",
        "--port",
        "0",
        "--database",
        ":memory:",
        ...(command === "server"
          ? ["--provider", "laptop", ...relativePaths]
          : []),
      ],
      { ...options, stdio: ["ignore", "ignore", "pipe"] },
    );

    const running: ChildProcess[] = [server];
    const controller = new AbortController();

    try {
      const url = await new Promise<string>((resolve) => {
        createInterface({ input: server.stderr }).on("line", (line) => {
          if (line.includes("server listening")) {
            resolve((JSON.parse(line) as { url: string }).url);
          }
        });
      });

      if (command === "agent") {
        const agent = spawn(
          process.execPath,
          [
            main,
            "agent",
            "--name",
            "laptop",
            "--server",
            url,
            ...relativePaths,
          ],
          { ...options, stdio: "ignore" },
        );

        running.unshift(agent);
      }

      let environment: Environment | undefined;
      while (environment === undefined) {
        const response = await fetch(new URL("/api/environments", url));

        environment = ((await response.json()) as Environment[]).find(
          (each) => each.provider === "laptop",
        );

        await sleep(20);
      }

      expect(environment.models).toContainEqual({
        provider: "proxy",
        id: "proxy-small",
      });

      const created = await fetch(new URL("/api/sessions", url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          environment: environment.id,
          workspace: { kind: "worktree", path: repository },
          model: { provider: "proxy", id: "proxy-small" },
        }),
      });

      const { id } = (await created.json()) as Session;

      const stream = await fetch(new URL(`/api/sessions/${id}/events`, url), {
        signal: controller.signal,
      });

      let settled: Session | undefined;
      for await (const event of readSse(
        stream,
      ) as AsyncGenerator<SessionEvent>) {
        if (
          event.type === "session" &&
          (event.session.status === "idle" || event.session.status === "failed")
        ) {
          settled = event.session;
          break;
        }
      }

      expect({ status: settled?.status, error: settled?.error }).toEqual({
        status: "idle",
        error: null,
      });

      const workspace = await stat(join(cwd, "data", "workspaces", id));

      expect(workspace.isDirectory()).toBe(true);

      controller.abort();
      for (const each of running) {
        each.kill("SIGTERM");
        await once(each, "exit");
      }
    } finally {
      controller.abort();
      for (const each of running) {
        each.kill("SIGKILL");
      }

      await rm(cwd, { recursive: true, force: true });
    }
  },
  30_000,
);

const proxyExtension = `export default (pi) => {
  pi.registerProvider("proxy", {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "test-key",
    api: "openai-completions",
    models: [
      {
        id: "proxy-small",
        name: "proxy-small",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      },
    ],
  });
};
`;

const git = promisify(execFile);

async function gitRepository(path: string): Promise<void> {
  await git("git", ["init", "--initial-branch=main", path]);
  await writeFile(join(path, "README.md"), "hello\n");
  await git("git", ["-C", path, "add", "."]);

  await git("git", [
    "-C",
    path,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "first",
  ]);
}
