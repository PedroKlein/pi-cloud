import { expect, test } from "bun:test";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { Environment, Session, SessionEvent } from "@pipoca/protocol";
import { readSse } from "./sse";
import { runnerCredentials } from "./testdata/runners";
import { firstUserCookie, setupTokenOf } from "./testdata/sign-in";

// Waits for a spawned server's setup link, which follows its listening line,
// and signs its first user in.
async function signedIn(server: {
  readonly stderr: Readable;
}): Promise<{ readonly url: string; readonly cookie: string }> {
  const lines: string[] = [];

  await new Promise((resolve) => {
    createInterface({ input: server.stderr }).on("line", (line) => {
      lines.push(line);
      if (line.includes("#setup/")) {
        resolve(undefined);
      }
    });
  });

  const listening = lines.find((line) => line.includes("server listening"));
  const { url } = JSON.parse(listening ?? "{}") as { url: string };

  return {
    url,
    cookie: await firstUserCookie(fetch, url, setupTokenOf(lines)),
  };
}

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

test("keeps using the data folder from before the product was renamed", async () => {
  const home = await mkdtemp(join(tmpdir(), "pipoca-home-"));
  await mkdir(join(home, ".pi-cloud"));

  const server = spawn(
    process.execPath,
    [join(import.meta.dirname, "main.ts"), "server", "--port", "0"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, HOME: home },
    },
  );

  try {
    await signedIn(server);

    const exists = async (path: string): Promise<boolean> =>
      stat(path).then(
        () => true,
        () => false,
      );

    expect([
      await exists(join(home, ".pi-cloud", "server.db")),
      await exists(join(home, ".pipoca")),
    ]).toEqual([true, false]);
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit");
    await rm(home, { recursive: true, force: true });
  }
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
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PIPOCA_KEY: "pck_unused" },
    },
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

test("exits an agent started to exit when idle once it has run no session for that long", async () => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), "pipoca-")));
  const main = join(import.meta.dirname, "main.ts");

  const server = spawn(
    process.execPath,
    [main, "server", "--port", "0", "--database", ":memory:"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  try {
    const { url, cookie } = await signedIn(server);

    const key = await runnerCredentials({ url: new URL(url) }, async () =>
      Promise.resolve(cookie),
    ).key("pods");

    const agent = spawn(
      process.execPath,
      [
        main,
        "agent",
        "--name",
        "pod-1",
        "--server",
        url,
        "--data-dir",
        dataDir,
        "--exit-when-idle",
        "1",
      ],
      { stdio: "ignore", env: { ...process.env, PIPOCA_KEY: key } },
    );

    const exited = once(agent, "exit") as Promise<[number | null]>;

    const timeout = sleep(15_000).then(() => {
      agent.kill("SIGKILL");

      return [null] as [number | null];
    });

    const [code] = await Promise.race([exited, timeout]);

    expect(code).toBe(0);
  } finally {
    server.kill("SIGKILL");
    await rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);

test("joins an agent started with only a join key under its host's name, sharing the folder it started in", async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "pipoca-")));
  const main = join(import.meta.dirname, "main.ts");

  const server = spawn(
    process.execPath,
    [main, "server", "--port", "0", "--database", ":memory:"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let agent: ChildProcess | undefined;

  try {
    const { url, cookie } = await signedIn(server);

    const made = await fetch(new URL("/api/join-key", url), {
      method: "POST",
      headers: { cookie },
    });

    const { key } = (await made.json()) as { key: string };

    agent = spawn(
      process.execPath,
      [main, "agent", "--server", url, "--data-dir", join(folder, ".agent")],
      {
        cwd: folder,
        stdio: "ignore",
        env: { ...process.env, PIPOCA_KEY: key },
      },
    );

    let environment: Environment | undefined;
    while (environment?.folders.length !== 1) {
      const response = await fetch(new URL("/api/environments", url), {
        headers: { cookie },
      });

      [environment] = (await response.json()) as Environment[];
      await sleep(20);
    }

    const name = hostname().split(".")[0];

    expect(environment.name).toBe(name ?? "");

    expect(environment.runners.map((runner) => runner.name)).toEqual([
      name ?? "",
    ]);

    expect(environment.folders).toEqual([folder]);
  } finally {
    agent?.kill("SIGKILL");
    server.kill("SIGKILL");
    await rm(folder, { recursive: true, force: true });
  }
}, 30_000);

test("stops an agent with the server's reason when a runner of its name is online", async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "pipoca-")));
  const main = join(import.meta.dirname, "main.ts");

  const server = spawn(
    process.execPath,
    [main, "server", "--port", "0", "--database", ":memory:"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const agent = (dataDir: string, key: string): ChildProcess =>
    spawn(
      process.execPath,
      [
        main,
        "agent",
        "--name",
        "mac",
        "--server",
        url,
        "--data-dir",
        join(folder, dataDir),
        "--folder",
        folder,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, PIPOCA_KEY: key },
      },
    );

  let url = "";
  let first: ChildProcess | undefined;

  try {
    const signed = await signedIn(server);
    url = signed.url;

    const created = await fetch(new URL("/api/environments", url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: signed.cookie },
      body: JSON.stringify({ name: "laptops" }),
    });

    const { key } = (await created.json()) as { key: string };
    first = agent("first", key);
    first.stderr?.resume();

    let environment: Environment | undefined;
    while (environment?.online !== true) {
      const response = await fetch(new URL("/api/environments", url), {
        headers: { cookie: signed.cookie },
      });

      [environment] = (await response.json()) as Environment[];
      await sleep(20);
    }

    const second = agent("second", key);
    let stderr = "";
    second.stderr?.setEncoding("utf8");

    second.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const [code] = (await once(second, "exit")) as [number | null];

    expect(code).toBe(1);
    expect(stderr).toEndWith("a runner named mac is online here\n");
    expect(stderr).not.toContain("join failed");
  } finally {
    first?.kill("SIGKILL");
    server.kill("SIGKILL");
    await rm(folder, { recursive: true, force: true });
  }
}, 30_000);

test("brings an agent restarted while its runner still shows online back under its own name", async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "pipoca-")));
  const main = join(import.meta.dirname, "main.ts");
  const [before, after] = [join(folder, "before"), join(folder, "after")];
  await Promise.all([mkdir(before), mkdir(after)]);

  const server = spawn(
    process.execPath,
    [main, "server", "--port", "0", "--database", ":memory:"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let serverLog = "";

  server.stderr.on("data", (chunk: Buffer) => {
    serverLog += chunk.toString();
  });

  let url = "";
  let key = "";

  const agent = (shared: string): ChildProcess =>
    spawn(
      process.execPath,
      [
        main,
        "agent",
        "--name",
        "mac",
        "--server",
        url,
        "--data-dir",
        join(folder, ".agent"),
        "--folder",
        shared,
      ],
      { stdio: "ignore", env: { ...process.env, PIPOCA_KEY: key } },
    );

  let running: ChildProcess | undefined;

  try {
    const signed = await signedIn(server);
    url = signed.url;

    const created = await fetch(new URL("/api/environments", url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: signed.cookie },
      body: JSON.stringify({ name: "laptops" }),
    });

    key = ((await created.json()) as { key: string }).key;

    const listed = async (shared: string): Promise<Environment> => {
      for (;;) {
        const response = await fetch(new URL("/api/environments", url), {
          headers: { cookie: signed.cookie },
        });

        const [environment] = (await response.json()) as Environment[];
        if (environment?.folders.includes(shared) === true) {
          return environment;
        }

        await sleep(20);
      }
    };

    running = agent(before);
    await listed(before);
    running.kill("SIGTERM");
    await once(running, "exit");

    running = agent(after);
    const environment = await listed(after);
    const saved = await stat(join(folder, ".agent", "runner.json"));

    expect(
      environment.runners.map(({ name, online }) => ({ name, online })),
    ).toEqual([{ name: "mac", online: true }]);

    expect(running.exitCode).toBeNull();
    expect(serverLog.match(/runner joined/g)).toHaveLength(1);
    expect(serverLog).not.toContain("runner refused");
    expect(saved.mode & 0o777).toBe(0o600);
  } finally {
    running?.kill("SIGKILL");
    server.kill("SIGKILL");
    await rm(folder, { recursive: true, force: true });
  }
}, 30_000);

test("marks a session failed and keeps running when its process cannot be spawned", async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "pipoca-")));

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
      join(folder, ".pipoca"),
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
    const { url, cookie } = await signedIn(server);

    let environment: Environment | undefined;
    while (environment === undefined) {
      const response = await fetch(new URL("/api/environments", url), {
        headers: { cookie },
      });

      environment = ((await response.json()) as Environment[]).find(
        (each) => each.provider === "laptop" && each.online,
      );

      await sleep(20);
    }

    const created = await fetch(new URL("/api/sessions", url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        environment: environment.id,
        workspace: { kind: "folder", path: folder },
      }),
    });

    const { id } = (await created.json()) as Session;

    const stream = await fetch(new URL(`/api/sessions/${id}/events`, url), {
      signal: controller.signal,
      headers: { cookie },
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
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pipoca-")));
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
      const { url, cookie } = await signedIn(server);

      if (command === "agent") {
        const key = await runnerCredentials({ url: new URL(url) }, async () =>
          Promise.resolve(cookie),
        ).key("laptop");

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
          {
            ...options,
            env: { ...options.env, PIPOCA_KEY: key },
            stdio: "ignore",
          },
        );

        running.unshift(agent);
      }

      let environment: Environment | undefined;
      while (environment === undefined) {
        const response = await fetch(new URL("/api/environments", url), {
          headers: { cookie },
        });

        environment = ((await response.json()) as Environment[]).find(
          (each) => each.provider === "laptop" && each.online,
        );

        await sleep(20);
      }

      expect(environment.models).toContainEqual({
        provider: "proxy",
        id: "proxy-small",
      });

      const created = await fetch(new URL("/api/sessions", url), {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          environment: environment.id,
          workspace: { kind: "worktree", path: repository },
          model: { provider: "proxy", id: "proxy-small" },
        }),
      });

      const { id } = (await created.json()) as Session;

      const stream = await fetch(new URL(`/api/sessions/${id}/events`, url), {
        signal: controller.signal,
        headers: { cookie },
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
