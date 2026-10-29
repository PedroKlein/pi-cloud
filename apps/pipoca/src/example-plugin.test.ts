import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInfo } from "@pipoca/protocol";
import { installedPlugins } from "./installed";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";

let root: string;
let server: ReturnType<typeof serve>;
let cookie: string;

// The plugin docs/plugins.md walks through, so the guide's code stays true.
const example = join(import.meta.dir, "../../../examples/plugins/greeter");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pipoca-example-"));

  const plugins = join(root, "plugins");
  await cp(example, join(plugins, "greeter"), { recursive: true });
  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["greeter"]));

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

  cookie = await firstUser(server, logs)();
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method,
    headers: {
      cookie,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

test("runs the guide's example plugin with all three parts", async () => {
  const all = (await (await api("GET", "/api/plugins")).json()) as PluginInfo[];
  const greeter = all.find(({ id }) => id === "greeter");

  expect(greeter).toMatchObject({ state: "on", source: "installed" });
  expect(greeter?.error).toBeUndefined();
  expect((await api("GET", greeter?.webPart ?? "/missing")).status).toBe(200);

  expect(
    await (await api("GET", "/api/plugins/greeter/greeting")).json(),
  ).toEqual({ greeting: "Hello" });

  await api("PATCH", "/api/plugins/greeter", {
    settings: { greeting: "Hi" },
  });

  expect(
    await (await api("GET", "/api/plugins/greeter/greeting")).json(),
  ).toEqual({ greeting: "Hi" });
});

test("answers the example's unknown routes with the server's 404", async () => {
  const missing = await api("GET", "/api/plugins/greeter/farewell");

  expect(missing.status).toBe(404);

  expect(await missing.json()).toEqual({
    error: "not_found",
    message: "the greeter has no farewell",
  });
});
