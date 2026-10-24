import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
  const container = await containerSession({
    sessionId: "s1",
    generation: 2,
    image: "debian:bookworm",
    binary: "/opt/pi-cloud-linux",
    dataDir: root,
    folders: ["/code"],
    cwd: "/code/app",
    variables: { TOKEN: "s3cret" },
  });

  const run = container.run.join(" ");

  expect(container.name).toBe("pi-session-s1-2");
  expect(run).toContain(`-v ${root}:${root}`);
  expect(run).toContain("-v /code:/code");
  expect(run).toContain("-v /code/app:/code/app");
  expect(run).toContain("-v /opt/pi-cloud-linux:/usr/local/bin/pi-cloud:ro");
  expect(run).toContain("-e TOKEN ");
  expect(run).toContain(`--user ${String(process.getuid?.())}:`);

  expect(run).toEndWith(
    "-w /code/app --entrypoint /usr/local/bin/pi-cloud debian:bookworm session",
  );

  expect(run).not.toContain("s3cret");
  expect(container.shell).toContain("pi-session-s1-2");
  expect(container.kill).toEqual(["docker", "kill", "pi-session-s1-2"]);
  expect((await stat(join(root, "container-home"))).isDirectory()).toBe(true);
});
