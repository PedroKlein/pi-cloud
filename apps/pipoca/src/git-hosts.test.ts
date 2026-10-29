import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  protocolVersion,
  versionHeader,
  type Work,
  type WorkPoll,
} from "@pipoca/protocol";
import { serve } from "./serve";
import { runnerCredentials } from "./testdata/runners";
import { firstUser } from "./testdata/sign-in";

const enterprise = "github.tools.sap";
const goodToken = "ghp_good";

let logs: string[];
let configDir: string;
let server: ReturnType<typeof serve>;
let pedro: () => Promise<string>;
let host: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  logs = [];

  // The host's REST API, which knows one token.
  host = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);

      if (request.headers.get("authorization") !== `Bearer ${goodToken}`) {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }

      const repository = (name: string): unknown => ({
        full_name: name,
        clone_url: `https://${enterprise}/${name}.git`,
      });

      switch (url.pathname) {
        case "/api/v3/user":
          return Response.json({ login: "pedro-sap" });
        case "/api/v3/user/repos":
          return Response.json([
            repository("I572543/pi-aicore-provider"),
            repository("I572543/dotfiles"),
          ]);
        case "/api/v3/search/repositories":
          return Response.json({
            items: [
              repository("I572543/pi-aicore-provider"),
              repository("ai-core/aicore-sdk"),
            ],
          });
        default:
          return Response.json({ message: "Not Found" }, { status: 404 });
      }
    },
  });

  configDir = mkdtempSync(join(tmpdir(), "pipoca-config-"));

  writeFileSync(
    join(configDir, "pipoca.json"),
    JSON.stringify({
      "git-hosts": {
        hosts: [
          {
            host: enterprise,
            label: "SAP GitHub",
            api: `http://127.0.0.1:${String(host.port)}/api/v3`,
          },
        ],
      },
    }),
  );

  server = serve({
    port: 0,
    database: ":memory:",
    configDir,
    sessions: { pollWaitMs: 0 },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  pedro = firstUser(server, logs);
});

afterEach(async () => {
  await server.stop();
  await host.stop();
});

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method,
    redirect: "manual",
    headers: {
      cookie: await pedro(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

// What a runner gets for a new Session of Pedro's.
async function assignment(): Promise<Assignment | undefined> {
  const token = await runnerToken();

  await api("POST", "/api/sessions", {
    workspace: { kind: "folder", path: "/srv/a" },
  });

  return polled(token);
}

async function runnerToken(): Promise<string> {
  return runnerCredentials(server, pedro).token("laptop", "laptops");
}

// What the runner gets for the first Session it can start.
async function polled(token: string): Promise<Assignment | undefined> {
  const poll: WorkPoll = { running: [], folders: ["/srv/a"], models: [] };

  const work = (await (
    await fetch(new URL("/agent/work", server.url), {
      method: "POST",
      headers: {
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(poll),
    })
  ).json()) as Work;

  return work.start[0];
}

test("lists only github.com when the config file names no hosts", async () => {
  writeFileSync(join(configDir, "pipoca.json"), "{}");

  const account = await (
    await api("GET", "/api/plugins/git-hosts/account")
  ).json();

  expect(account).toMatchObject({
    hosts: [{ host: "github.com", label: "GitHub", oauth: false }],
    connections: [],
  });
});

test("connects a host with a token and signs the person's Sessions in with it", async () => {
  const connected = await api("POST", "/api/plugins/git-hosts/connect", {
    host: enterprise,
    token: goodToken,
  });

  const page = await connected.text();

  expect(connected.status).toBe(200);
  expect(page).toContain('"login":"pedro-sap"');
  expect(page).not.toContain(goodToken);

  expect((await assignment())?.gitLogins).toEqual([
    { host: enterprise, token: goodToken },
  ]);

  expect(logs.join("\n")).not.toContain(goodToken);
});

test("signs the coordinator of a Project in with the git logins of the person who started it", async () => {
  await api("POST", "/api/plugins/git-hosts/connect", {
    host: enterprise,
    token: goodToken,
  });

  const token = await runnerToken();

  const created = await api("POST", "/api/plugins/projects/projects", {
    name: "Release",
    repositories: [`https://${enterprise}/I572543/pi-aicore-provider.git`],
  });

  expect(created.status).toBe(200);

  expect((await polled(token))?.gitLogins).toEqual([
    { host: enterprise, token: goodToken },
  ]);
});

test("sends no login for a host after the person disconnects it", async () => {
  await api("POST", "/api/plugins/git-hosts/connect", {
    host: enterprise,
    token: goodToken,
  });

  await api("POST", "/api/plugins/git-hosts/disconnect", { host: enterprise });

  expect((await assignment())?.gitLogins).toBeUndefined();
});

test("refuses a token the host doesn't accept, saying so", async () => {
  const refused = await api("POST", "/api/plugins/git-hosts/connect", {
    host: enterprise,
    token: "ghp_wrong",
  });

  expect(refused.status).toBe(400);

  expect(await refused.json()).toEqual({
    error: `${enterprise} doesn't accept this token`,
  });
});

test("keeps a host's OAuth secret sealed in pipoca.json and out of the page", async () => {
  const added = await api("POST", "/api/plugins/git-hosts/hosts", {
    host: "GitHub.example.com",
    label: "Example",
    clientId: "Iv1.abc",
    clientSecret: "shh",
  });

  expect(added.status).toBe(201);

  expect(await added.json()).toEqual({
    host: "github.example.com",
    label: "Example",
    clientId: "Iv1.abc",
    hasClientSecret: true,
    clientSecretEnv: null,
  });

  const file = readFileSync(join(configDir, "pipoca.json"), "utf8");

  expect(file).toContain('"clientId": "Iv1.abc"');
  expect(file).not.toContain("shh");

  const account = await (
    await api("GET", "/api/plugins/git-hosts/account")
  ).json();

  expect(account).toMatchObject({
    hosts: [
      { host: enterprise, oauth: false },
      { host: "github.example.com", oauth: true },
    ],
  });
});

test("won't save over hosts edited by hand into a list that doesn't fit", async () => {
  await api("GET", "/api/plugins/git-hosts/hosts");

  const edited = JSON.stringify({
    "git-hosts": { hosts: [{ host: enterprise, api: "ftp://nowhere" }] },
  });

  writeFileSync(join(configDir, "pipoca.json"), edited);

  const added = await api("POST", "/api/plugins/git-hosts/hosts", {
    host: "github.example.com",
  });

  expect(added.status).toBe(400);

  expect(await added.json()).toEqual({
    error:
      "fix git-hosts in pipoca.json first: git-hosts.hosts[0]: api must be an http or https URL",
  });

  expect(readFileSync(join(configDir, "pipoca.json"), "utf8")).toBe(edited);
});

test("sends a sign-in to the host's authorize page, and refuses a callback in another browser", async () => {
  writeFileSync(
    join(configDir, "pipoca.json"),
    JSON.stringify({
      "git-hosts": {
        hosts: [
          {
            host: enterprise,
            oauth: { clientId: "Iv1.abc", clientSecretEnv: "SAP_SECRET" },
          },
        ],
      },
    }),
  );

  process.env["SAP_SECRET"] = "shh";

  const started = await api(
    "GET",
    `/api/plugins/git-hosts/sign-in/${enterprise}`,
  );

  const location = new URL(started.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";

  expect(started.status).toBe(302);

  expect(location.origin + location.pathname).toBe(
    `https://${enterprise}/login/oauth/authorize`,
  );

  expect(location.searchParams.get("client_id")).toBe("Iv1.abc");

  expect(location.searchParams.get("redirect_uri")).toBe(
    new URL("/api/plugins/git-hosts/callback", server.url).href,
  );

  expect(process.env["SAP_SECRET"]).toBeUndefined();

  const elsewhere = await fetch(
    new URL(
      `/api/plugins/git-hosts/callback?state=${state}&code=c0de`,
      server.url,
    ),
  );

  expect(elsewhere.status).toBe(400);
});

test("finds the repositories of each connected host for what the person typed", async () => {
  await api("POST", "/api/plugins/git-hosts/connect", {
    host: enterprise,
    token: goodToken,
  });

  const found = await (
    await api("GET", "/api/plugins/git-hosts/repositories?q=aicore")
  ).json();

  expect(found).toEqual([
    {
      url: `https://${enterprise}/I572543/pi-aicore-provider.git`,
      name: "I572543/pi-aicore-provider",
      group: "SAP GitHub",
    },
    {
      url: `https://${enterprise}/ai-core/aicore-sdk.git`,
      name: "ai-core/aicore-sdk",
      group: "SAP GitHub",
    },
  ]);
});
