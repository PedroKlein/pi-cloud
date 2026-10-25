import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  Assignment,
  Environment,
  Profile,
  ProfileExport,
  Session,
} from "@pi-cloud/protocol";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";

const run = promisify(execFile);

let root: string;
let server: ReturnType<typeof serve>;
let signedIn: () => Promise<string>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "profiles-"));

  const logs: string[] = [];

  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 0 },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

async function api(
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      cookie: await signedIn(),
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
}

async function json<T>(response: Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

async function poll(): Promise<{ readonly start: readonly Assignment[] }> {
  return json(
    fetch(new URL("/agent/work", server.url), {
      method: "POST",
      headers: {
        "pi-cloud-protocol": "1",
        "pi-cloud-provider": "vm",
        "content-type": "application/json",
      },
      body: JSON.stringify({ running: [], folders: [], models: [] }),
    }),
  );
}

async function vmEnvironment(): Promise<string> {
  await poll();

  const environments = await json<Environment[]>(api("/api/environments"));

  return environments[0]?.id ?? "";
}

const content = {
  packages: ["npm:pi-goal-x", { source: "git:github.com/me/kit", skills: [] }],
  agentsMd: "Be brief.",
  systemMd: "",
  appendSystemMd: "Answer in English.",
  mcpServers: { docs: { url: "https://example.com/mcp" } },
  settings: { defaultThinkingLevel: "high" },
};

test("starts with one empty default Profile", async () => {
  expect(await json<Profile[]>(api("/api/profiles"))).toEqual([
    {
      id: expect.any(String) as string,
      name: "Default",
      ownerId: "local",
      createdAt: expect.any(String) as string,
      isDefault: true,
      packages: [],
      agentsMd: "",
      systemMd: "",
      appendSystemMd: "",
      mcpServers: {},
      settings: {},
    },
  ]);
});

test("creates, edits and makes a Profile the default", async () => {
  const created = await json<Profile>(
    api("/api/profiles", { body: { name: "Work", ...content } }),
  );

  expect(created).toMatchObject({ name: "Work", isDefault: false, ...content });

  const edited = await json<Profile>(
    api(`/api/profiles/${created.id}`, {
      method: "PUT",
      body: { agentsMd: "Be thorough." },
    }),
  );

  expect(edited).toMatchObject({
    name: "Work",
    agentsMd: "Be thorough.",
    packages: content.packages,
  });

  await api(`/api/profiles/${created.id}/default`, { body: {} });
  const profiles = await json<Profile[]>(api("/api/profiles"));

  expect(profiles.map(({ name, isDefault }) => ({ name, isDefault }))).toEqual([
    { name: "Default", isDefault: false },
    { name: "Work", isDefault: true },
  ]);
});

test("rejects Profile content Pi couldn't use", async () => {
  const cases = [
    { name: "" },
    { name: "x", packages: "npm:a" },
    { name: "x", packages: [{ skills: [] }] },
    { name: "x", settings: { packages: ["npm:a"] } },
    { name: "x", mcpServers: [] },
    { name: "x", agentsMd: 3 },
  ];

  for (const body of cases) {
    const response = await api("/api/profiles", { body });

    expect({ body, status: response.status }).toEqual({ body, status: 400 });
  }
});

test("a new Session runs with the Profile it names, or else the default", async () => {
  const environment = await vmEnvironment();

  const work = await json<Profile>(
    api("/api/profiles", { body: { name: "Work", ...content } }),
  );

  const [defaultProfile] = await json<Profile[]>(api("/api/profiles"));
  const workspace = { kind: "folder", path: root };

  const named = await json<Session>(
    api("/api/sessions", {
      body: { environment, workspace, profile: work.id },
    }),
  );

  const plain = await json<Session>(
    api("/api/sessions", { body: { environment, workspace } }),
  );

  expect(named.profileId).toBe(work.id);
  expect(plain.profileId).toBe(defaultProfile?.id ?? "");

  const { start } = await poll();
  const assigned = start.find(({ sessionId }) => sessionId === named.id);

  expect(assigned?.profile).toEqual({ id: work.id, ...content });

  const unknown = await api("/api/sessions", {
    body: { environment, workspace, profile: "nope" },
  });

  expect(unknown.status).toBe(400);
  expect(await unknown.json()).toEqual({ error: "unknown_profile" });
});

test("keeps the default Profile and Profiles in use", async () => {
  const environment = await vmEnvironment();
  const [defaultProfile] = await json<Profile[]>(api("/api/profiles"));

  const work = await json<Profile>(
    api("/api/profiles", { body: { name: "Work" } }),
  );

  const session = await json<Session>(
    api("/api/sessions", {
      body: {
        environment,
        workspace: { kind: "folder", path: root },
        profile: work.id,
      },
    }),
  );

  const deleteProfile = async (id: string): Promise<number> =>
    (await api(`/api/profiles/${id}`, { method: "DELETE" })).status;

  expect(await deleteProfile(defaultProfile?.id ?? "")).toBe(409);
  expect(await deleteProfile(work.id)).toBe(409);

  await api(`/api/sessions/${session.id}/archive`, { body: {} });

  expect(await deleteProfile(work.id)).toBe(204);
  expect(await deleteProfile(work.id)).toBe(404);
});

test("exports a Profile and imports the file as a copy", async () => {
  const work = await json<Profile>(
    api("/api/profiles", { body: { name: "Work", ...content } }),
  );

  const response = await api(`/api/profiles/${work.id}/export`);
  const file = (await response.json()) as ProfileExport;

  expect(response.headers.get("content-disposition")).toBe(
    'attachment; filename="Work.json"',
  );

  expect(file).toEqual({ piCloudProfile: 1, name: "Work", ...content });

  const imported = await json<Profile>(
    api("/api/profiles/import", { body: file }),
  );

  expect(imported.id).not.toBe(work.id);

  expect(imported).toMatchObject({
    name: "Work",
    isDefault: false,
    ...content,
  });

  const notAProfile = await api("/api/profiles/import", {
    body: { name: "x" },
  });

  expect(notAProfile.status).toBe(400);
});

test("imports from git only over https or ssh", async () => {
  const repository = join(root, "kit");
  await run("git", ["init", "--quiet", repository]);

  for (const url of [repository, `file://${repository}`, "-u", "http://x/y"]) {
    const response = await api("/api/profiles/import", { body: { url } });

    expect({ url, status: response.status }).toEqual({ url, status: 400 });
  }

  const notText = await api("/api/profiles/import", { body: { url: 5 } });

  expect(await notText.json()).toEqual({ error: "url must be a string" });
});

test("a Session whose Profile was deleted can't come back", async () => {
  const environment = await vmEnvironment();

  const work = await json<Profile>(
    api("/api/profiles", { body: { name: "Work" } }),
  );

  const session = await json<Session>(
    api("/api/sessions", {
      body: {
        environment,
        workspace: { kind: "folder", path: root },
        profile: work.id,
      },
    }),
  );

  await api(`/api/sessions/${session.id}/archive`, { body: {} });
  await api(`/api/profiles/${work.id}`, { method: "DELETE" });

  const unarchived = await api(`/api/sessions/${session.id}/unarchive`, {
    body: {},
  });

  expect(unarchived.status).toBe(400);
  expect(await unarchived.json()).toEqual({ error: "unknown_profile" });
});

test("keeps a repository trust answer for the next Session in it", async () => {
  const environment = await vmEnvironment();
  const workspace = { kind: "folder", path: root };

  const first = await json<Session>(
    api("/api/sessions", { body: { environment, workspace } }),
  );

  const [asked] = (await poll()).start;

  expect(asked?.trusted).toBeNull();

  const answered = await fetch(
    new URL(`/agent/sessions/${first.id}/trust`, server.url),
    {
      method: "POST",
      headers: {
        "pi-cloud-protocol": "1",
        "pi-cloud-provider": "vm",
        "content-type": "application/json",
      },
      body: JSON.stringify({ generation: asked?.generation, trusted: true }),
    },
  );

  expect(answered.status).toBe(204);

  const second = await json<Session>(
    api("/api/sessions", { body: { environment, workspace } }),
  );

  const { start } = await poll();

  expect(start.find(({ sessionId }) => sessionId === second.id)?.trusted).toBe(
    true,
  );
});
