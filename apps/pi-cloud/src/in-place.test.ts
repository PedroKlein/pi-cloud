import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInfo } from "@pi-cloud/protocol";
import { installedPlugins } from "./installed";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";

let root: string;
let plugins: string;
let server: ReturnType<typeof serve> | undefined;
let cookie: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-cloud-in-place-"));
  plugins = join(root, "plugins");
  cookie = "";
  await mkdir(plugins);
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

async function start(): Promise<void> {
  await server?.stop();

  const logs: string[] = [];

  server = serve({
    port: 0,
    database: join(root, "server.db"),
    sessions: { pollWaitMs: 0 },
    installed: {
      root: plugins,
      plugins: await installedPlugins(plugins, () => undefined),
    },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  if (cookie === "") {
    cookie = await firstUser(server, logs)();
  }
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(new URL(path, server?.url), {
    method,
    headers: {
      cookie,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function write(
  plugin: string,
  path: string,
  content: string,
): Promise<Response> {
  return api("PUT", `/api/plugin-files/${plugin}`, { path, content });
}

async function errorOf(response: Promise<Response>): Promise<string> {
  const settled = await response;

  expect(settled.status).toBe(400);

  return ((await settled.json()) as { error: string }).error;
}

const manifest = (parts: Record<string, string> = { server: "server.ts" }) =>
  JSON.stringify({
    type: "module",
    piCloud: {
      id: "hello",
      title: "Hello",
      description: "Says hi.",
      engine: 1,
      capabilities: ["routes"],
      parts,
    },
  });

const serverPart = `export default {
  name: "hello",
  register: (context) => {
    context.routes.handle(async () => new Response("hi"));
  },
};
`;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

test("writes a new plugin turned off, and lists and reads its files", async () => {
  await start();

  const written = await write("hello", "package.json", manifest());

  expect(await written.json()).toMatchObject({
    id: "hello",
    title: "Hello",
    source: "installed",
    state: "off",
    turnedOn: false,
  });

  await write("hello", "src/util.ts", "export const two = 2;\n");

  expect(await (await api("GET", "/api/plugin-files/hello")).json()).toEqual([
    "package.json",
    "src/util.ts",
  ]);

  expect(
    await (
      await api("GET", "/api/plugin-files/hello?path=src%2Futil.ts")
    ).json(),
  ).toEqual({ path: "src/util.ts", content: "export const two = 2;\n" });
});

test("builds a plugin turned off without running it, and says why one doesn't build", async () => {
  await start();
  await write("hello", "package.json", manifest());

  await write(
    "hello",
    "server.ts",
    `${serverPart}\nawait Bun.write(${JSON.stringify(join(root, "ran"))}, "");`,
  );

  const built = await api("POST", "/api/plugin-builds/hello");

  expect(built.status).toBe(200);
  expect(await exists(join(plugins, "hello", ".build"))).toBe(true);
  expect(await exists(join(root, "ran"))).toBe(false);
  expect((await api("GET", "/api/plugins/hello/")).status).toBe(404);

  await write("hello", "server.ts", "export default {");

  expect(await errorOf(api("POST", "/api/plugin-builds/hello"))).toContain(
    "doesn't build",
  );
});

test("builds without running a macro, which would run the plugin's code", async () => {
  const mark = join(root, "macro-ran");

  await start();
  await write("hello", "package.json", manifest());

  await write(
    "hello",
    "macro.ts",
    `export function hi() { Bun.write(${JSON.stringify(mark)}, ""); return "hi"; }\n`,
  );

  await write(
    "hello",
    "server.ts",
    `import { hi } from "./macro.ts" with { type: "macro" };\n\nexport default { name: hi(), register: () => undefined };\n`,
  );

  expect(await errorOf(api("POST", "/api/plugin-builds/hello"))).toContain(
    "Macros are disabled",
  );

  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(await exists(mark)).toBe(false);
});

test("keeps writes inside the plugin's own files", async () => {
  const outside = join(root, "outside");
  await mkdir(outside);
  await start();
  await write("hello", "package.json", manifest());
  await symlink(outside, join(plugins, "hello", "out"));

  for (const path of [
    "../escaped.ts",
    "/etc/escaped",
    ".build/server.js",
    "node_modules/x/index.js",
    ".source.json",
    "",
  ]) {
    expect((await write("hello", path, "x")).status).toBe(400);
  }

  expect(await errorOf(write("hello", "out/x.ts", "x"))).toContain(
    "outside the plugin's folder",
  );

  expect(await errorOf(write("hello", "out/sub/x.ts", "x"))).toContain(
    "outside the plugin's folder",
  );

  expect(await exists(join(outside, "x.ts"))).toBe(false);
  expect(await exists(join(outside, "sub"))).toBe(false);
  expect(await exists(join(root, "escaped.ts"))).toBe(false);
});

test("changes only plugins turned off that are its own to change", async () => {
  await start();
  await write("hello", "package.json", manifest());
  await write("hello", "server.ts", serverPart);
  await api("PATCH", "/api/plugins/hello", { enabled: true });

  expect(await errorOf(write("hello", "server.ts", "x"))).toContain(
    "turned on",
  );

  await start();
  await api("PATCH", "/api/plugins/hello", { enabled: false });

  expect(await errorOf(api("POST", "/api/plugin-builds/hello"))).toContain(
    "running",
  );

  expect(await errorOf(write("projects", "x.ts", "x"))).toContain("built-in");

  await mkdir(join(plugins, "pinned"));

  await writeFile(
    join(plugins, "pinned", ".source.json"),
    JSON.stringify({ url: "https://example.com/p.git", pinned: "abc" }),
  );

  expect(await errorOf(write("pinned", "x.ts", "x"))).toContain("updating");

  await mkdir(join(root, "elsewhere"));
  await symlink(join(root, "elsewhere"), join(plugins, "linked"));

  expect(await errorOf(write("linked", "x.ts", "x"))).toContain("elsewhere");

  expect(await readFile(join(plugins, "hello", "server.ts"), "utf8")).toBe(
    serverPart,
  );
});

test("shows a plugin's broken manifest once it is written", async () => {
  await start();
  await write("hello", "package.json", "{");

  const listed = (await (
    await api("GET", "/api/plugins")
  ).json()) as PluginInfo[];

  expect(listed.find(({ id }) => id === "hello")).toMatchObject({
    state: "failed",
  });
});
