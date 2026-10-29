import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  type Assignment,
  type Environment,
  emptyProfile,
  type Profile,
  type ProfileFiles,
  type Session,
  type WorkPoll,
} from "@pipoca/protocol";
import { serve } from "./serve";
import { runnerCredentials } from "./testdata/runners";
import { firstUser } from "./testdata/sign-in";

const run = promisify(execFile);

let root: string;
let server: ReturnType<typeof serve>;
let signedIn: () => Promise<string>;
let runners: ReturnType<typeof runnerCredentials>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "profiles-"));

  const logs: string[] = [];

  server = serve({
    port: 0,
    database: join(root, "server.db"),
    configDir: join(root, "config"),
    sessions: { pollWaitMs: 0 },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
  runners = runnerCredentials(server, signedIn);
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

async function poll(
  models: Pick<WorkPoll, "models" | "registeredModels"> = { models: [] },
): Promise<{ readonly start: readonly Assignment[] }> {
  return json(
    fetch(new URL("/agent/work", server.url), {
      method: "POST",
      headers: {
        "pipoca-protocol": "4",
        authorization: `Bearer ${await runners.token("vm")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ running: [], folders: [], ...models }),
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

test("starts with one empty default Profile, shared by everyone", async () => {
  expect(await json<Profile[]>(api("/api/profiles"))).toEqual([
    {
      id: "default",
      name: "Default",
      ownerId: null,
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

  expect(created).toMatchObject({
    id: "work",
    name: "Work",
    ownerId: "local",
    isDefault: false,
    ...content,
  });

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

  expect(assigned?.profile).toEqual({
    id: work.id,
    hash: expect.any(String) as string,
  });

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

test("exports a Profile's folder and imports it as a copy", async () => {
  await api("/api/profiles", { body: { name: "Work", ...content } });

  await mkdir(join(root, "config", "profiles", "work", "skills", "review"), {
    recursive: true,
  });

  await writeFile(
    join(root, "config", "profiles", "work", "skills", "review", "SKILL.md"),
    "# Review",
  );

  const response = await api("/api/profiles/work/export");

  expect(response.headers.get("content-disposition")).toBe(
    'attachment; filename="work.tar.gz"',
  );

  const archive = new Uint8Array(await response.arrayBuffer());

  const imported = await json<Profile>(
    fetch(new URL("/api/profiles/import?name=Work", server.url), {
      method: "POST",
      headers: { cookie: await signedIn(), "content-type": "application/gzip" },
      body: archive,
    }),
  );

  expect(imported).toMatchObject({
    id: "work-2",
    name: "Work",
    ownerId: "local",
    isDefault: false,
    ...content,
  });

  expect(
    await readFile(
      join(
        root,
        "config",
        "profiles",
        "work-2",
        "skills",
        "review",
        "SKILL.md",
      ),
      "utf8",
    ),
  ).toBe("# Review");
});

test("imports someone's own Pi folder without their logins or history", async () => {
  const archive = await new Bun.Archive(
    {
      "./AGENTS.md": "Be brief.",
      "./auth.json": "{}",
      "./sessions/one.jsonl": "{}",
      "./prompts/fix.md": "Fix it.",
    },
    { compress: "gzip" },
  ).bytes();

  const imported = await json<Profile>(
    fetch(new URL("/api/profiles/import?name=Mine", server.url), {
      method: "POST",
      headers: { cookie: await signedIn(), "content-type": "application/gzip" },
      body: archive,
    }),
  );

  const files = await json<{ path: string }[]>(
    api(`/api/profiles/${imported.id}/files`),
  );

  expect(files.map(({ path }) => path)).toEqual([
    "AGENTS.md",
    "prompts/fix.md",
  ]);
});

test("still imports a Profile file exported before Profiles were folders", async () => {
  const imported = await json<Profile>(
    api("/api/profiles/import", {
      body: { pipocaProfile: 1, name: "Work", ...content },
    }),
  );

  expect(imported).toMatchObject({ name: "Work", ...content });

  const notAProfile = await api("/api/profiles/import", {
    body: { name: "x" },
  });

  expect(notAProfile.status).toBe(400);
});

test("reads, writes, uploads and deletes a Profile's files", async () => {
  await api("/api/profiles", { body: { name: "Work" } });

  const put = async (path: string, text: string): Promise<number> =>
    (
      await fetch(new URL(`/api/profiles/work/files/${path}`, server.url), {
        method: "PUT",
        headers: { cookie: await signedIn() },
        body: text,
      })
    ).status;

  expect(await put("skills%2Freview%2FSKILL.md", "# Review")).toBe(204);
  expect(await put("auth.json", "{}")).toBe(400);
  expect(await put("..%2Fescape", "x")).toBe(400);

  const uploaded = await api("/api/profiles/work/files", {
    body: {
      files: {
        "prompts/fix.md": Buffer.from("Fix it.").toString("base64"),
        "AGENTS.md": Buffer.from("Be brief.").toString("base64"),
      },
    },
  });

  expect(uploaded.status).toBe(204);

  expect(await json<unknown>(api("/api/profiles/work/files"))).toEqual([
    { path: "AGENTS.md", size: 9 },
    { path: "prompts/fix.md", size: 7 },
    { path: "skills/review/SKILL.md", size: 8 },
  ]);

  const read = await api("/api/profiles/work/files/skills%2Freview%2FSKILL.md");

  expect(await read.text()).toBe("# Review");

  const deleted = await api("/api/profiles/work/files/AGENTS.md", {
    method: "DELETE",
  });

  expect(deleted.status).toBe(204);
  expect((await json<Profile>(api("/api/profiles/work"))).agentsMd).toBe("");
  expect((await api("/api/profiles/work/files/AGENTS.md")).status).toBe(404);
});

test("refuses a file path that isn't valid percent-encoding", async () => {
  await api("/api/profiles", { body: { name: "Work" } });

  const statuses = await Promise.all(
    ["/api/profiles/work/files/%E0%A4%A", "/api/base/files/%E0%A4%A"].flatMap(
      (path) =>
        ["GET", "PUT", "DELETE"].map(async (method) => {
          const response = await fetch(new URL(path, server.url), {
            method,
            headers: { cookie: await signedIn() },
            ...(method === "PUT" && { body: "x" }),
          });

          return `${method} ${path} ${String(response.status)}`;
        }),
    ),
  );

  expect(statuses).toEqual([
    "GET /api/profiles/work/files/%E0%A4%A 400",
    "PUT /api/profiles/work/files/%E0%A4%A 400",
    "DELETE /api/profiles/work/files/%E0%A4%A 400",
    "GET /api/base/files/%E0%A4%A 400",
    "PUT /api/base/files/%E0%A4%A 400",
    "DELETE /api/base/files/%E0%A4%A 400",
  ]);
});

test("only admins change a shared Profile's files", async () => {
  const db = new DatabaseSync(join(root, "server.db"));
  await signedIn();
  db.exec("update users set admin = 0");
  db.close();

  const response = await fetch(
    new URL("/api/profiles/default/files/AGENTS.md", server.url),
    { method: "PUT", headers: { cookie: await signedIn() }, body: "x" },
  );

  expect(response.status).toBe(403);
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
        "pipoca-protocol": "4",
        authorization: `Bearer ${await runners.token("vm")}`,
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

test("keeps a Profile as a Pi agent folder people can edit by hand", async () => {
  await api("/api/profiles", { body: { name: "Work", ...content } });

  const folder = join(root, "config", "profiles", "work");

  expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe("Be brief.");

  expect(
    JSON.parse(await readFile(join(folder, "settings.json"), "utf8")),
  ).toEqual({
    defaultThinkingLevel: "high",
    packages: content.packages,
  });

  expect(JSON.parse(await readFile(join(folder, "mcp.json"), "utf8"))).toEqual({
    mcpServers: content.mcpServers,
  });

  await writeFile(join(folder, "AGENTS.md"), "Edited by hand.");
  await mkdir(join(root, "config", "profiles", "review"));

  await writeFile(
    join(root, "config", "profiles", "review", "settings.json"),
    JSON.stringify({ defaultModel: "gpt-5", theme: "dark" }),
  );

  const profiles = await json<Profile[]>(api("/api/profiles"));

  expect(
    profiles.map(({ id, name, ownerId, agentsMd }) => ({
      id,
      name,
      ownerId,
      agentsMd,
    })),
  ).toEqual([
    { id: "default", name: "Default", ownerId: null, agentsMd: "" },
    { id: "review", name: "review", ownerId: null, agentsMd: "" },
    { id: "work", name: "Work", ownerId: "local", agentsMd: "Edited by hand." },
  ]);

  await api("/api/profiles/review", {
    method: "PUT",
    body: { packages: ["npm:pi-review"] },
  });

  expect(
    JSON.parse(
      await readFile(
        join(root, "config", "profiles", "review", "settings.json"),
        "utf8",
      ),
    ),
  ).toEqual({
    defaultModel: "gpt-5",
    theme: "dark",
    packages: ["npm:pi-review"],
  });
});

test("only admins create, change or delete shared Profiles", async () => {
  const shared = await json<Profile>(
    api("/api/profiles", { body: { name: "Team", shared: true } }),
  );

  expect(shared.ownerId).toBeNull();

  const db = new DatabaseSync(join(root, "server.db"));
  db.exec("update users set admin = 0");
  db.close();

  const statuses = await Promise.all([
    api("/api/profiles", { body: { name: "Mine too", shared: true } }),
    api("/api/profiles/default", { method: "PUT", body: { agentsMd: "x" } }),
    api(`/api/profiles/${shared.id}`, { method: "DELETE" }),
  ]);

  expect(statuses.map(({ status }) => status)).toEqual([403, 403, 403]);

  const mine = await api("/api/profiles", { body: { name: "Mine" } });

  expect(mine.status).toBe(201);

  const used = await api(`/api/profiles/${shared.id}/default`, { body: {} });

  expect(used.status).toBe(200);
});

test("hands runners a Profile's whole folder, without what machines keep", async () => {
  const environment = await vmEnvironment();
  await api("/api/profiles", { body: { name: "Work", agentsMd: "Be brief." } });

  const folder = join(root, "config", "profiles", "work");
  await mkdir(join(folder, "skills", "review"), { recursive: true });
  await mkdir(join(folder, "git"));
  await writeFile(join(folder, "skills", "review", "SKILL.md"), "# Review");
  await writeFile(join(folder, "auth.json"), "{}");
  await writeFile(join(folder, "git", "cached"), "x");
  await symlink("/etc/hostname", join(folder, "linked"));

  const session = await json<Session>(
    api("/api/sessions", {
      body: {
        environment,
        workspace: { kind: "folder", path: root },
        profile: "work",
      },
    }),
  );

  const [assigned] = (await poll()).start;

  const files = await json<ProfileFiles>(
    fetch(new URL(`/agent/sessions/${session.id}/profile`, server.url), {
      headers: {
        "pipoca-protocol": "4",
        authorization: `Bearer ${await runners.token("vm")}`,
      },
    }),
  );

  expect(files.hash).toBe(assigned?.profile.hash ?? "");

  expect(
    Object.fromEntries(
      Object.entries(files.files).map(([path, encoded]) => [
        path,
        Buffer.from(encoded, "base64").toString("utf8"),
      ]),
    ),
  ).toEqual({ "AGENTS.md": "Be brief.", "skills/review/SKILL.md": "# Review" });
});

test("fails a Session whose Profile is too big for runners", async () => {
  const environment = await vmEnvironment();
  await api("/api/profiles", { body: { name: "Huge" } });

  await writeFile(
    join(root, "config", "profiles", "huge", "blob"),
    Buffer.alloc(21 * 1024 * 1024),
  );

  const session = await json<Session>(
    api("/api/sessions", {
      body: {
        environment,
        workspace: { kind: "folder", path: root },
        profile: "huge",
      },
    }),
  );

  expect((await poll()).start).toEqual([]);

  expect(await json<Session>(api(`/api/sessions/${session.id}`))).toMatchObject(
    { status: "failed", error: "Profile Huge is over 20 MB" },
  );
});

test("layers the admin's base Profile under every Profile runners get", async () => {
  const environment = await vmEnvironment();

  const put = async (path: string, text: string): Promise<number> =>
    (
      await fetch(new URL(`/api/base/files/${path}`, server.url), {
        method: "PUT",
        headers: { cookie: await signedIn() },
        body: text,
      })
    ).status;

  expect(await put("AGENTS.md", "Use the team's style.")).toBe(204);
  expect(await put("skills%2Fshared%2FSKILL.md", "# Shared")).toBe(204);
  expect(await put("skills%2Freview%2FSKILL.md", "# Team review")).toBe(204);

  expect(
    await put(
      "settings.json",
      JSON.stringify({
        packages: ["npm:ai-provider", "npm:pi-goal-x"],
        defaultThinkingLevel: "low",
        retry: { enabled: true, maxRetries: 2 },
      }),
    ),
  ).toBe(204);

  expect(await put("auth.json", "{}")).toBe(400);

  expect(await json<unknown>(api("/api/base/files"))).toEqual([
    { path: "AGENTS.md", size: 21 },
    { path: "settings.json", size: 117 },
    { path: "skills/review/SKILL.md", size: 13 },
    { path: "skills/shared/SKILL.md", size: 8 },
  ]);

  await api("/api/profiles", {
    body: {
      name: "Work",
      agentsMd: "Be brief.",
      packages: [{ source: "npm:pi-goal-x", skills: [] }],
      settings: { defaultThinkingLevel: "high", retry: { maxRetries: 5 } },
    },
  });

  await mkdir(join(root, "config", "profiles", "work", "skills", "review"), {
    recursive: true,
  });

  await writeFile(
    join(root, "config", "profiles", "work", "skills", "review", "SKILL.md"),
    "# My review",
  );

  const filesOf = async (
    profile: string,
  ): Promise<{ hash: string; files: Record<string, string> }> => {
    const session = await json<Session>(
      api("/api/sessions", {
        body: {
          environment,
          workspace: { kind: "folder", path: root },
          profile,
        },
      }),
    );

    const assigned = (await poll()).start.find(
      ({ sessionId }) => sessionId === session.id,
    );

    const files = await json<ProfileFiles>(
      fetch(new URL(`/agent/sessions/${session.id}/profile`, server.url), {
        headers: {
          "pipoca-protocol": "4",
          authorization: `Bearer ${await runners.token("vm")}`,
        },
      }),
    );

    expect(files.hash).toBe(assigned?.profile.hash ?? "");

    return {
      hash: files.hash,
      files: Object.fromEntries(
        Object.entries(files.files).map(([path, encoded]) => [
          path,
          Buffer.from(encoded, "base64").toString("utf8"),
        ]),
      ),
    };
  };

  const work = await filesOf("work");

  expect<Record<string, unknown>>({
    ...work.files,
    "settings.json": JSON.parse(work.files["settings.json"] ?? "{}") as unknown,
  }).toEqual({
    "AGENTS.md": "Use the team's style.\n\nBe brief.",
    "settings.json": {
      packages: ["npm:ai-provider", { source: "npm:pi-goal-x", skills: [] }],
      defaultThinkingLevel: "high",
      retry: { enabled: true, maxRetries: 5 },
    },
    "skills/review/SKILL.md": "# My review",
    "skills/shared/SKILL.md": "# Shared",
  });

  const plain = await filesOf("default");

  expect(Object.keys(plain.files)).toEqual([
    "AGENTS.md",
    "settings.json",
    "skills/review/SKILL.md",
    "skills/shared/SKILL.md",
  ]);

  expect(await put("skills%2Fshared%2FSKILL.md", "# Shared, edited")).toBe(204);
  expect((await filesOf("default")).hash).not.toBe(plain.hash);
});

test("edits the base Profile's packages and AGENTS.md like a Profile's", async () => {
  expect(await json<unknown>(api("/api/base"))).toEqual(emptyProfile);

  await fetch(new URL("/api/base/files/settings.json", server.url), {
    method: "PUT",
    headers: { cookie: await signedIn() },
    body: JSON.stringify({ defaultThinkingLevel: "low" }),
  });

  const updated = await api("/api/base", {
    method: "PUT",
    body: { packages: ["npm:ai-provider"], agentsMd: "Be kind." },
  });

  expect(updated.status).toBe(200);

  expect(await json<unknown>(api("/api/base"))).toEqual({
    ...emptyProfile,
    packages: ["npm:ai-provider"],
    agentsMd: "Be kind.",
    settings: { defaultThinkingLevel: "low" },
  });

  expect(
    (await api("/api/base", { method: "PUT", body: { packages: "npm:x" } }))
      .status,
  ).toBe(400);
});

test("only admins change the base Profile", async () => {
  const db = new DatabaseSync(join(root, "server.db"));
  await signedIn();
  db.exec("update users set admin = 0");
  db.close();

  const response = await fetch(
    new URL("/api/base/files/AGENTS.md", server.url),
    { method: "PUT", headers: { cookie: await signedIn() }, body: "x" },
  );

  expect(response.status).toBe(403);
  expect(await json<unknown>(api("/api/base/files"))).toEqual([]);

  expect(
    (await api("/api/base", { method: "PUT", body: { agentsMd: "x" } })).status,
  ).toBe(403);
});

test("offers the models extension providers registered on runners, after a restart", async () => {
  const gemini = { provider: "google", id: "gemini-flash" };
  const aiCore = { provider: "aicore", id: "gpt-x" };

  await poll({ models: [gemini], registeredModels: [gemini, aiCore] });

  const environmentOf = async (): Promise<Environment | undefined> =>
    (await json<Environment[]>(api("/api/environments")))[0];

  expect((await environmentOf())?.models).toEqual([gemini, aiCore]);

  await server.stop();

  const logs: string[] = [];

  server = serve({
    port: 0,
    database: join(root, "server.db"),
    configDir: join(root, "config"),
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  expect((await environmentOf())?.models).toEqual([gemini, aiCore]);
});
