import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
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
  root = await mkdtemp(join(tmpdir(), "pi-cloud-installed-"));
  plugins = join(root, "plugins");
  cookie = "";
  await mkdir(plugins);
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

const noLog = (): void => undefined;

// A plugin folder whose server part answers on its route, and leaves a mark
// when it is imported.
async function writePlugin(
  id: string,
  manifest: Record<string, unknown> = {},
  register = `context.routes.handle(async () => new Response("hi from ${id}"));`,
): Promise<void> {
  const folder = join(plugins, id);
  await mkdir(folder);

  await writeFile(
    join(folder, "package.json"),
    JSON.stringify({
      name: id,
      piCloud: {
        id,
        title: `The ${id} plugin`,
        description: "Says hi.",
        engine: 1,
        parts: { server: "server.ts" },
        capabilities: ["routes"],
        ...manifest,
      },
    }),
  );

  await writeFile(
    join(folder, "server.ts"),
    `await Bun.write(${JSON.stringify(join(folder, "imported"))}, "");

export default {
  name: ${JSON.stringify(id)},
  register: (context) => {
    ${register}
  },
};
`,
  );
}

// Starts the server the way the CLI does, so a restart reads the folder again.
async function start(): Promise<void> {
  await server?.stop();

  const logs: string[] = [];

  server = serve({
    port: 0,
    database: join(root, "server.db"),
    sessions: { pollWaitMs: 0 },
    installed: {
      root: plugins,
      plugins: await installedPlugins(plugins, noLog),
    },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  // The database outlives a restart, and the first user's cookie with it.
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

async function listed(id: string): Promise<PluginInfo | undefined> {
  const all = (await (await api("GET", "/api/plugins")).json()) as PluginInfo[];

  return all.find((plugin) => plugin.id === id);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

test("lists an installed plugin turned off, without running its code", async () => {
  await writePlugin("hello");
  await start();

  expect(await listed("hello")).toMatchObject({
    source: "installed",
    state: "off",
    turnedOn: false,
    title: "The hello plugin",
  });

  expect(await exists(join(plugins, "hello", "imported"))).toBe(false);
  expect((await api("GET", "/api/plugins/hello/")).status).toBe(404);
});

test("turns an installed plugin on for the next start", async () => {
  await writePlugin("hello");
  await start();

  const turned = await api("PATCH", "/api/plugins/hello", { enabled: true });

  expect(await turned.json()).toMatchObject({ state: "off", turnedOn: true });

  expect(
    JSON.parse(await readFile(join(plugins, "enabled.json"), "utf8")),
  ).toEqual(["hello"]);

  await start();

  const route = await api("GET", "/api/plugins/hello/");

  expect(await listed("hello")).toMatchObject({ state: "on", turnedOn: true });
  expect(await route.text()).toBe("hi from hello");

  await api("PATCH", "/api/plugins/hello", { enabled: false });
  await start();

  expect(await listed("hello")).toMatchObject({
    state: "off",
    turnedOn: false,
  });
});

test("fails a plugin that reaches past the capabilities it declared", async () => {
  await writePlugin(
    "nosy",
    { capabilities: [] },
    "context.sessions.owned('x');",
  );

  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["nosy"]));
  await start();

  const nosy = await listed("nosy");

  expect(nosy?.state).toBe("failed");
  expect(nosy?.error).toContain("sessions without declaring it");
});

test("fails a plugin whose manifest this server can't load", async () => {
  await writePlugin("future", { engine: 2 });
  await writePlugin("misnamed", { id: "other" });
  await start();

  expect((await listed("future"))?.error).toContain("engine must be 1");
  expect((await listed("misnamed"))?.error).toContain("folder's name");
});

test("turns built-in plugins on or off only through the server's options", async () => {
  await start();

  const refused = await api("PATCH", "/api/plugins/projects", {
    enabled: false,
  });

  expect(refused.status).toBe(400);
  expect((await listed("projects"))?.turnedOn).toBe(true);
});

test("keeps a built-in plugin when a folder takes its id", async () => {
  await writePlugin("projects");
  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["projects"]));
  await start();

  const all = (await (await api("GET", "/api/plugins")).json()) as PluginInfo[];

  expect(all.filter(({ id }) => id === "projects")).toMatchObject([
    { source: "built-in", state: "on" },
  ]);

  expect(await exists(join(plugins, "projects", "imported"))).toBe(false);
});

test("keeps every switch when several are turned at once", async () => {
  const ids = ["a", "b", "c", "d"];

  for (const id of ids) {
    await writePlugin(id);
  }

  await start();

  const turned = await Promise.all(
    ids.map(async (id) =>
      api("PATCH", `/api/plugins/${id}`, { enabled: true }),
    ),
  );

  expect(turned.map(({ status }) => status)).toEqual([200, 200, 200, 200]);

  expect(
    JSON.parse(await readFile(join(plugins, "enabled.json"), "utf8")),
  ).toEqual(ids);
});

test("won't turn on a plugin whose manifest is broken", async () => {
  await writePlugin("future", { engine: 2 });
  await start();

  const refused = await api("PATCH", "/api/plugins/future", { enabled: true });

  expect(refused.status).toBe(400);
  expect(await exists(join(plugins, "enabled.json"))).toBe(false);
});

test("loads a plugin whose folder is a link to one elsewhere", async () => {
  await writePlugin("linked");
  await rename(join(plugins, "linked"), join(root, "linked"));
  await symlink(join(root, "linked"), join(plugins, "linked"));
  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["linked"]));
  await start();

  expect(await (await api("GET", "/api/plugins/linked/")).text()).toBe(
    "hi from linked",
  );
});

test("won't import a server part that links outside the plugin", async () => {
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, "server.ts"), "export default {};");

  await writePlugin("sneaky", { parts: { server: "outside/server.ts" } });
  await symlink(elsewhere, join(plugins, "sneaky", "outside"));
  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["sneaky"]));
  await start();

  expect((await listed("sneaky"))?.error).toContain("outside the plugin");
});

test("starts with every installed plugin off when enabled.json is broken", async () => {
  await writePlugin("hello");
  await writeFile(join(plugins, "enabled.json"), "[");
  await start();

  expect(await listed("hello")).toMatchObject({ state: "off" });
});
