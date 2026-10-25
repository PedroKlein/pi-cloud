import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { $ } from "bun";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PluginInfo, Session, SessionEvent } from "@pi-cloud/protocol";
import { installedPlugins } from "./installed";
import { serve, type ServeOptions } from "./serve";
import { readSse } from "./sse";
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
  parent = plugins,
): Promise<void> {
  const folder = join(parent, id);
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
async function start(agent?: ServeOptions["agent"]): Promise<void> {
  await server?.stop();

  const logs: string[] = [];

  server = serve({
    port: 0,
    database: join(root, "server.db"),
    sessions: { pollWaitMs: agent ? 100 : 0 },
    ...(agent && { agent }),
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

test("builds a plugin with its dependencies, without its scripts, before running it", async () => {
  await writePlugin("greeter");

  const folder = join(plugins, "greeter");
  await mkdir(join(folder, "vendor", "greeting"), { recursive: true });

  await writeFile(
    join(folder, "vendor", "greeting", "package.json"),
    JSON.stringify({ name: "greeting", version: "1.0.0", main: "index.ts" }),
  );

  await writeFile(
    join(folder, "vendor", "greeting", "index.ts"),
    `export const greeting = "hi from a dependency";\n`,
  );

  const manifest = JSON.parse(
    await readFile(join(folder, "package.json"), "utf8"),
  ) as Record<string, unknown>;

  await writeFile(
    join(folder, "package.json"),
    JSON.stringify({
      ...manifest,
      dependencies: { greeting: "file:./vendor/greeting" },
      scripts: { prepare: "exit 3" },
    }),
  );

  await writeFile(
    join(folder, "server.ts"),
    `import { greeting } from "greeting";

export default {
  name: "greeter",
  register: (context) => {
    context.routes.handle(async () => new Response(greeting));
  },
};
`,
  );

  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["greeter"]));
  await start();

  expect(await (await api("GET", "/api/plugins/greeter/")).text()).toBe(
    "hi from a dependency",
  );
});

test("runs a plugin's source as it is at each start", async () => {
  await writePlugin("hello");
  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["hello"]));
  await start();

  const part = join(plugins, "hello", "server.ts");
  const source = await readFile(part, "utf8");

  await writeFile(part, source.replace("hi from hello", "hello again"));
  await start();

  expect(await (await api("GET", "/api/plugins/hello/")).text()).toBe(
    "hello again",
  );
});

test("shows why a plugin doesn't build", async () => {
  await writePlugin("broken");
  await writeFile(join(plugins, "broken", "server.ts"), "export default {");
  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["broken"]));
  await start();

  const broken = await listed("broken");

  expect(broken?.state).toBe("failed");
  expect(broken?.error).toContain("server.ts doesn't build");
  expect(broken?.error).toMatch(/broken\/server\.ts:1:\d+: /);
});

test("serves a running plugin's web part, built against the page's modules", async () => {
  await writePlugin("pages", { parts: { web: "web.tsx" } });

  await writeFile(
    join(plugins, "pages", "web.tsx"),
    `import { useState } from "react";

export default { name: "pages", hook: useState };
`,
  );

  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["pages"]));
  await start();

  const webPart = (await listed("pages"))?.webPart ?? "";
  const served = await api("GET", webPart);

  expect(webPart).toMatch(/^\/api\/plugin-parts\/pages\/web-\w+\.js$/);
  expect(served.headers.get("content-type")).toContain("javascript");
  expect(await served.text()).toContain('globalThis.piCloudShared["react"]');

  expect((await api("GET", "/api/plugin-parts/pages/server.ts")).status).toBe(
    404,
  );
});

test("names a web part's bundle so its URL needs no escaping", async () => {
  await writePlugin("spaced", { parts: { web: "my page.tsx" } });

  await writeFile(
    join(plugins, "spaced", "my page.tsx"),
    `export default { name: "spaced" };\n`,
  );

  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["spaced"]));
  await start();

  const webPart = (await listed("spaced"))?.webPart ?? "";

  expect((await api("GET", webPart)).status).toBe(200);
});

test("fails a web part that imports CSS the page would never load", async () => {
  await writePlugin("styled", { parts: { web: "web.tsx" } });
  await writeFile(join(plugins, "styled", "look.css"), "p { color: red; }\n");

  await writeFile(
    join(plugins, "styled", "web.tsx"),
    `import "./look.css";\n\nexport default { name: "styled" };\n`,
  );

  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["styled"]));
  await start();

  expect((await listed("styled"))?.error).toContain("imports CSS");
});

// A Session part that adds a slash command, so a Session shows it loaded.
async function writeSlashPlugin(
  manifest: Record<string, unknown> = {},
): Promise<void> {
  await writePlugin("slash", { parts: { session: "session.ts" }, ...manifest });

  await writeFile(
    join(plugins, "slash", "session.ts"),
    `export default {
  name: "slash",
  extension: () => (pi) => {
    pi.registerCommand("installed-hello", {
      description: "Says hi from an installed plugin",
      handler: async () => undefined,
    });
  },
};
`,
  );

  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["slash"]));
}

// Starts the server with its own runner on a faux model, and a Session on it.
async function startSession(): Promise<Session> {
  const faux = fauxProvider();

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);

  await start({
    provider: "local",
    dataDir: join(root, "local"),
    extensionPaths: [],
    folders: [root],
    models: { runtime, model: faux.getModel() },
  });

  while (
    ((await (await api("GET", "/api/environments")).json()) as unknown[])
      .length === 0
  ) {
    await Bun.sleep(10);
  }

  return (await (
    await api("POST", "/api/sessions", {
      workspace: { kind: "folder", path: root },
    })
  ).json()) as Session;
}

async function commandsOf(session: Session): Promise<readonly string[]> {
  const events = await api("GET", `/api/sessions/${session.id}/events`);

  for await (const event of readSse(events)) {
    const sent = event as SessionEvent;

    if (sent.type === "live" && sent.event.type === "commands") {
      return sent.event.commands.map(({ name }) => name);
    }
  }

  return [];
}

test("runs an installed plugin's Session part in a Session, fetched by its hash", async () => {
  await writeSlashPlugin();

  const session = await startSession();

  expect(await commandsOf(session)).toContain("installed-hello");

  const cached = await readdir(
    join(root, "local", "sessions", session.id, "plugin-parts"),
  );

  expect(cached).toHaveLength(1);
  expect(cached[0]).toMatch(/^slash-[0-9a-f]{64}\.js$/);
});

test("keeps a Session part meant for its own Sessions out of others", async () => {
  await writeSlashPlugin({ ownSessionsOnly: true });

  const session = await startSession();
  const commands = await commandsOf(session);

  expect(commands).toContain("pr");
  expect(commands).not.toContain("installed-hello");
});

test("fails a Session part that imports a file the runner wouldn't get", async () => {
  await writePlugin("prompted", { parts: { session: "session.ts" } });
  await writeFile(join(plugins, "prompted", "prompt.png"), "not really");

  await writeFile(
    join(plugins, "prompted", "session.ts"),
    `import prompt from "./prompt.png";\n\nexport default { name: "prompted", prompt };\n`,
  );

  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["prompted"]));
  await start();

  expect((await listed("prompted"))?.error).toContain(
    "imports files other than code",
  );
});

// A git repository holding a plugin, committed, and the URL to install it by.
async function gitPlugin(
  id: string,
  manifest: Record<string, unknown> = {},
  register?: string,
): Promise<string> {
  const sources = join(root, "sources");
  const folder = join(sources, id);

  await mkdir(sources, { recursive: true });
  await writePlugin(id, manifest, register, sources);
  await $`git -C ${folder} init -q`;
  await commit(folder);

  return `file://${folder}`;
}

async function commit(folder: string): Promise<string> {
  await $`git -C ${folder} add -A`;
  await $`git -C ${folder} -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm c`;

  return (await $`git -C ${folder} rev-parse HEAD`.text()).trim();
}

async function install(url: string): Promise<Response> {
  return api("POST", "/api/plugins", { url });
}

test("installs a plugin from a git repository turned off, pinned to its commit", async () => {
  const url = await gitPlugin("hello");

  const pinned = (
    await $`git -C ${join(root, "sources", "hello")} rev-parse HEAD`.text()
  ).trim();

  await start();

  const installed = await install(url);

  expect(installed.status).toBe(201);

  expect(await installed.json()).toMatchObject({
    id: "hello",
    source: "installed",
    state: "off",
    turnedOn: false,
    installedFrom: { url, pinned },
  });

  expect(await exists(join(plugins, "hello", ".git"))).toBe(false);
  expect(await exists(join(plugins, "hello", "imported"))).toBe(false);

  await api("PATCH", "/api/plugins/hello", { enabled: true });
  await start();

  expect(await (await api("GET", "/api/plugins/hello/")).text()).toBe(
    "hi from hello",
  );

  expect((await listed("hello"))?.installedFrom).toEqual({ url, pinned });
});

test("installs a plugin from a branch or tag after # in its URL", async () => {
  const url = await gitPlugin("hello");
  const folder = join(root, "sources", "hello");

  await $`git -C ${folder} tag v1`;
  const tagged = (await $`git -C ${folder} rev-parse HEAD`.text()).trim();
  await writeFile(join(folder, "later.txt"), "");
  await commit(folder);
  await start();

  const installed = (await (await install(`${url}#v1`)).json()) as PluginInfo;

  expect(installed.installedFrom?.pinned).toBe(tagged);
});

test("installs a plugin from a tarball, pinned to its SHA-256", async () => {
  await gitPlugin("packed");

  const tarball = join(root, "packed.tgz");
  await $`tar -czf ${tarball} -C ${join(root, "sources")} packed`;

  const hash = new Bun.CryptoHasher("sha256")
    .update(await readFile(tarball))
    .digest("hex");

  await start();

  const installed = await install(`file://${tarball}`);

  expect(await installed.json()).toMatchObject({
    id: "packed",
    installedFrom: { pinned: `sha256:${hash}` },
  });

  expect(await exists(join(plugins, "packed", "server.ts"))).toBe(true);
});

test("refuses an install that would take an id already here, leaving nothing behind", async () => {
  await writePlugin("hello");
  const taken = await gitPlugin("hello");
  const builtIn = await gitPlugin("projects");

  await start();

  const twice = await install(taken);
  const projects = await install(builtIn);

  expect(twice.status).toBe(400);

  expect(((await twice.json()) as { error: string }).error).toContain(
    "already here",
  );

  expect(projects.status).toBe(400);

  expect(((await projects.json()) as { error: string }).error).toContain(
    "built-in",
  );

  expect((await readdir(plugins)).sort()).toEqual(["hello"]);
});

test("refuses to install from anything but an https, ssh or file URL", async () => {
  await start();

  for (const url of ["http://example.com/x.git", "ext::sh -c id", "-u"]) {
    expect((await install(url)).status).toBe(400);
  }
});

test("updates a plugin to its repository's newest commit for the next start", async () => {
  const url = await gitPlugin("hello");
  const folder = join(root, "sources", "hello");

  await start();
  await install(url);
  await api("PATCH", "/api/plugins/hello", { enabled: true });
  await start();

  const same = await api("PATCH", "/api/plugins/hello", { update: true });

  expect(await same.json()).not.toHaveProperty("updated");

  await writeFile(
    join(folder, "server.ts"),
    `export default {
  name: "hello",
  register: (context) => {
    context.routes.handle(async () => new Response("hi again"));
  },
};
`,
  );

  const newest = await commit(folder);

  const updated = await api("PATCH", "/api/plugins/hello", { update: true });

  expect(await updated.json()).toMatchObject({
    state: "on",
    turnedOn: true,
    updated: true,
    installedFrom: { pinned: newest },
  });

  expect(await (await api("GET", "/api/plugins/hello/")).text()).toBe(
    "hi from hello",
  );

  await start();

  expect(await (await api("GET", "/api/plugins/hello/")).text()).toBe(
    "hi again",
  );
});

test("turns off an update that asks for more than was trusted", async () => {
  const url = await gitPlugin("hello");
  const folder = join(root, "sources", "hello");

  await start();
  await install(url);
  await api("PATCH", "/api/plugins/hello", { enabled: true });

  const manifest = JSON.parse(
    await readFile(join(folder, "package.json"), "utf8"),
  ) as { piCloud: { capabilities: string[] } };

  manifest.piCloud.capabilities = ["routes", "sessions"];
  await writeFile(join(folder, "package.json"), JSON.stringify(manifest));
  await commit(folder);

  const updated = await api("PATCH", "/api/plugins/hello", { update: true });

  expect(await updated.json()).toMatchObject({
    turnedOn: false,
    capabilities: ["routes", "sessions"],
  });

  expect(
    JSON.parse(await readFile(join(plugins, "enabled.json"), "utf8")),
  ).toEqual([]);
});

test("won't update a plugin put in the folder by hand", async () => {
  await writePlugin("hello");
  await start();

  const refused = await api("PATCH", "/api/plugins/hello", { update: true });

  expect(refused.status).toBe(400);
});

test("removes an installed plugin only once it isn't running", async () => {
  await writePlugin("hello");
  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["hello"]));
  await start();

  const running = await api("DELETE", "/api/plugins/hello");

  expect(running.status).toBe(400);

  await api("PATCH", "/api/plugins/hello", { enabled: false });
  await start();

  const removed = await api("DELETE", "/api/plugins/hello");

  expect(removed.status).toBe(204);
  expect(await listed("hello")).toBeUndefined();
  expect(await exists(join(plugins, "hello"))).toBe(false);
  expect((await api("DELETE", "/api/plugins/hello")).status).toBe(404);
  expect((await api("DELETE", "/api/plugins/projects")).status).toBe(400);
});

test("removes only the link to a plugin developed elsewhere", async () => {
  await writePlugin("linked");
  await rename(join(plugins, "linked"), join(root, "linked"));
  await symlink(join(root, "linked"), join(plugins, "linked"));
  await start();

  await api("DELETE", "/api/plugins/linked");

  expect(await exists(join(plugins, "linked"))).toBe(false);
  expect(await exists(join(root, "linked", "package.json"))).toBe(true);
});

test("refuses a plugin holding a link, which could aim the server's writes anywhere", async () => {
  const victim = join(root, "victim.txt");
  await writeFile(victim, "untouched");

  const url = await gitPlugin("linky");
  const folder = join(root, "sources", "linky");
  await symlink(victim, join(folder, ".source.json"));
  await commit(folder);
  await start();

  const refused = await install(url);

  expect(refused.status).toBe(400);

  expect(((await refused.json()) as { error: string }).error).toContain(
    "holds a link, .source.json",
  );

  expect(await readFile(victim, "utf8")).toBe("untouched");
  expect(await readdir(plugins)).toEqual([]);
});

test("refuses a URL holding credentials, since every user sees where a plugin came from", async () => {
  await start();

  const refused = await install("https://me:token@example.com/plugin.git");

  expect(((await refused.json()) as { error: string }).error).toContain(
    "credentials",
  );
});

test("keeps the running version's settings until the server restarts", async () => {
  const url = await gitPlugin(
    "hello",
    {
      settings: {
        greeting: { type: "string", title: "Greeting", default: "hi" },
      },
    },
    `context.routes.handle(async () => Response.json(context.settings.get()));`,
  );

  const folder = join(root, "sources", "hello");

  await start();
  await install(url);
  await api("PATCH", "/api/plugins/hello", { enabled: true });
  await start();

  const manifest = JSON.parse(
    await readFile(join(folder, "package.json"), "utf8"),
  ) as { piCloud: Record<string, unknown> };

  manifest.piCloud["settings"] = {
    salute: { type: "string", title: "Salute", default: "yo" },
  };

  await writeFile(join(folder, "package.json"), JSON.stringify(manifest));
  await commit(folder);
  await api("PATCH", "/api/plugins/hello", { update: true });

  expect(await (await api("GET", "/api/plugins/hello/")).json()).toEqual({
    greeting: "hi",
  });

  expect((await listed("hello"))?.settings).toHaveProperty("salute");

  await start();

  expect(await (await api("GET", "/api/plugins/hello/")).json()).toEqual({
    salute: "yo",
  });
});

test("turns off an update that adds a part running somewhere new", async () => {
  const url = await gitPlugin("hello");
  const folder = join(root, "sources", "hello");

  await start();
  await install(url);
  await api("PATCH", "/api/plugins/hello", { enabled: true });

  const manifest = JSON.parse(
    await readFile(join(folder, "package.json"), "utf8"),
  ) as { piCloud: { parts: Record<string, string> } };

  manifest.piCloud.parts["session"] = "session.ts";
  await writeFile(join(folder, "package.json"), JSON.stringify(manifest));

  await writeFile(
    join(folder, "session.ts"),
    `export default { name: "hello" };\n`,
  );

  await commit(folder);

  const updated = await api("PATCH", "/api/plugins/hello", { update: true });

  expect(await updated.json()).toMatchObject({ turnedOn: false });
});

test("installs turned off even when a plugin of its id was turned on and removed by hand", async () => {
  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["hello"]));

  const url = await gitPlugin("hello");

  await start();
  await install(url);
  await start();

  expect(await listed("hello")).toMatchObject({
    state: "off",
    turnedOn: false,
  });
});

test("clears what an install that didn't finish left in the folder", async () => {
  await mkdir(join(plugins, ".install-left"));
  await mkdir(join(plugins, ".old-left"));
  await start();

  expect(await readdir(plugins)).toEqual([]);
});
