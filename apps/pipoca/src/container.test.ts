import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerSession } from "./container";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "container-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("runs a Session in its image as this user, with its paths, binary and variable names", async () => {
  await mkdir(join(root, "logins"));

  const container = await containerSession({
    sessionId: "s1",
    generation: 2,
    image: "debian:bookworm",
    binary: "/opt/pipoca-linux",
    folders: [root, join(root, "missing")],
    session: {
      cwd: "/code/app",
      checkouts: [{ path: "/code/app", base: null }],
      agentDir: join(root, "profiles", "p1"),
      sessionDir: join(root, "sessions", "s1"),
      authPath: join(root, "logins", "auth.json"),
      modelsPath: join(root, "logins", "models.json"),
      extensionPaths: ["/ext/tool.ts", "npm:pi-goal"],
      trusted: null,
      systemPrompt: null,
    },
    variables: { TOKEN: "s3cret" },
  });

  const run = container.run.join(" ");
  const bind = (path: string): string => `type=bind,src=${path},dst=${path}`;

  expect(container.name).toBe("pi-session-s1-2");
  expect(run).toContain(bind("/code/app"));
  expect(run).toContain(bind(root));
  expect(run).toContain(bind(join(root, "profiles", "p1")));
  expect(run).toContain(bind(join(root, "sessions", "s1")));
  expect(run).toContain(bind(join(root, "logins")));
  expect(run).toContain(`${bind("/ext/tool.ts")},readonly`);

  expect(run).toContain(
    "type=bind,src=/opt/pipoca-linux,dst=/usr/local/bin/pipoca,readonly",
  );

  expect(run).not.toContain("missing");
  expect(run).not.toContain("auth.json");
  expect(run).not.toContain("npm:pi-goal");
  expect(run).toContain("-e TOKEN ");
  expect(run).toContain(`--user ${String(process.getuid?.())}:`);

  expect(run).toEndWith(
    "-w /code/app --entrypoint /usr/local/bin/pipoca debian:bookworm session",
  );

  expect(run).not.toContain("s3cret");
  expect(container.shell).toContain("pi-session-s1-2");
  expect(container.kill).toEqual(["docker", "kill", "pi-session-s1-2"]);

  expect((await stat(join(root, "sessions", "s1", "home"))).isDirectory()).toBe(
    true,
  );
});
