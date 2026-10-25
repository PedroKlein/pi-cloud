import { afterEach, expect, test } from "bun:test";
import type {
  ServerPlugin,
  ServerPluginContext,
  ServerTool,
} from "@pi-cloud/plugins";
import {
  type Assignment,
  type PluginInfo,
  type PluginManifest,
  protocolVersion,
  versionHeader,
  type WorkPoll,
} from "@pi-cloud/protocol";
import { sessionParts } from "./plugins";
import { serve } from "./serve";
import { runnerCredentials } from "./testdata/runners";
import { firstUser } from "./testdata/sign-in";

let server: ReturnType<typeof serve> | undefined;
let signedIn: () => Promise<string>;
let runners: ReturnType<typeof runnerCredentials>;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const greeter: PluginManifest = {
  id: "greeter",
  title: "Greeter",
  description: "Greets people.",
  settings: {
    greeting: { type: "string", title: "Greeting", default: "hello" },
    times: { type: "number", title: "Times", default: 1, min: 1, max: 5 },
  },
};

function start(plugins: readonly ServerPlugin[]): void {
  const logs: string[] = [];

  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 0 },
    plugins,
    manifests: [greeter],
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
  runners = runnerCredentials(server, signedIn);
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(new URL(path, server?.url), {
    method,
    headers: {
      cookie: await signedIn(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function asRunner(path: string, body?: WorkPoll): Promise<Response> {
  return fetch(new URL(path, server?.url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      [versionHeader]: String(protocolVersion),
      authorization: `Bearer ${await runners.token("laptop")}`,
      "content-type": "application/json",
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function claimSession(): Promise<Assignment> {
  await runners.token("laptop");

  const created = (await (
    await api("POST", "/api/sessions", {
      workspace: { kind: "folder", path: "/work" },
    })
  ).json()) as { readonly id: string };

  const work = (await (
    await asRunner("/agent/work", {
      running: [],
      folders: ["/work"],
      models: [],
    })
  ).json()) as { readonly start: readonly Assignment[] };

  const assignment = work.start.find(
    ({ sessionId }) => sessionId === created.id,
  );

  if (assignment === undefined) {
    throw new Error("the runner was given no Session");
  }

  return assignment;
}

const echo = (name: string): ServerTool => ({
  name,
  description: "Echoes",
  parameters: { type: "object" },
  appliesTo: () => true,
  run: async () => Promise.resolve({ text: "echo", isError: false }),
});

test("saves a plugin's settings, refusing values that don't fit", async () => {
  let context: ServerPluginContext | undefined;

  start([
    {
      name: "greeter",
      register: (given) => {
        context = given;
      },
    },
  ]);

  const listed = (await (
    await api("GET", "/api/plugins")
  ).json()) as PluginInfo[];

  expect(listed).toEqual([
    {
      ...greeter,
      source: "built-in",
      state: "on",
      turnedOn: true,
      values: { greeting: "hello", times: 1 },
    },
  ]);

  const refused = await api("PATCH", "/api/plugins/greeter", {
    settings: { times: 9 },
  });

  expect(refused.status).toBe(400);

  expect(await refused.json()).toEqual({
    error: "Times must be a number, at least 1, at most 5",
  });

  const saved = await api("PATCH", "/api/plugins/greeter", {
    settings: { greeting: "hi", times: 3 },
  });

  expect(((await saved.json()) as PluginInfo).values).toEqual({
    greeting: "hi",
    times: 3,
  });

  expect(context?.settings.get()).toEqual({ greeting: "hi", times: 3 });
  expect((await api("PATCH", "/api/plugins/nobody", {})).status).toBe(404);
});

test("gives a starting Session its plugins' settings", async () => {
  start([{ name: "greeter", register: () => undefined }]);

  await api("PATCH", "/api/plugins/greeter", { settings: { times: 2 } });

  const assignment = await claimSession();

  expect(assignment.plugins).toEqual(["greeter"]);

  expect(assignment.pluginSettings).toEqual({
    greeter: { greeting: "hello", times: 2 },
  });
});

test("turns off a plugin that throws while it registers and keeps the rest", async () => {
  const heard: string[] = [];
  let signal: AbortSignal | undefined;

  start([
    {
      name: "broken",
      register: ({ tools, routes, events, signal: given }) => {
        signal = given;
        tools.register(echo("shared"));
        routes.handle(() => Response.json({ broken: true }));

        events.subscribe("demo.Ping", () => {
          heard.push("broken");
        });

        throw new Error("no config file");
      },
    },
    {
      name: "greeter",
      register: ({ tools, events, routes }) => {
        tools.register(echo("shared"));

        events.subscribe("demo.Ping", () => {
          heard.push("greeter");
        });

        routes.handle(() => {
          events.publish({ type: "demo.Ping" });

          return Response.json({ pinged: true });
        });
      },
    },
  ]);

  const listed = (await (
    await api("GET", "/api/plugins")
  ).json()) as PluginInfo[];

  expect(listed.map(({ id, state, error }) => ({ id, state, error }))).toEqual([
    { id: "broken", state: "failed", error: "no config file" },
    { id: "greeter", state: "on", error: undefined },
  ]);

  expect((await api("GET", "/api/plugins/broken/anything")).status).toBe(404);
  expect((await api("GET", "/api/plugins/greeter/ping")).status).toBe(200);
  expect(heard).toEqual(["greeter"]);
  expect(signal?.aborted).toBe(true);

  const assignment = await claimSession();

  expect(assignment.plugins).toEqual(["greeter"]);

  const tools = await asRunner(
    `/agent/sessions/${assignment.sessionId}/tools?generation=${String(assignment.generation)}`,
  );

  expect(
    ((await tools.json()) as { readonly name: string }[]).map(
      ({ name }) => name,
    ),
  ).toEqual(["shared"]);
});

test("gives a Session part its defaults when the server sends no settings", async () => {
  const { plugins, pluginSettings } = await sessionParts(
    { plugins: ["library"] },
    noInstalledParts,
  );

  expect(plugins.map(({ name }) => name)).toEqual(["library"]);
  expect(pluginSettings).toEqual({ library: { fileLimitMb: 10 } });
});

async function noInstalledParts(): Promise<never> {
  return Promise.reject(new Error("no installed parts here"));
}
