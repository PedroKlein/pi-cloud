import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";

const clientId = "pipoca-test";

interface Account {
  readonly sub: string;
  readonly email: string;
  readonly email_verified?: boolean;
  groups?: string[];
  readonly [claim: string]: unknown;
}

let logs: string[];
let server: ReturnType<typeof serve>;
let provider: ReturnType<typeof fakeProvider>;
let pedro: () => Promise<string>;
let providerId: string;
let configDir: string;

beforeEach(async () => {
  logs = [];
  provider = fakeProvider();

  configDir = mkdtempSync(join(tmpdir(), "pipoca-config-"));

  server = serve({
    port: 0,
    database: ":memory:",
    configDir,
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  pedro = firstUser(server, logs);
  providerId = await addProvider(provider.issuer);
});

afterEach(async () => {
  await server.stop();
  await provider.stop();
});

async function api(
  method: string,
  path: string,
  cookie: string,
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

function providerInput(
  issuer: string,
  more: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    issuer,
    clientId,
    label: "Sign in with IAS",
    accessGroup: "pipoca-users",
    adminGroup: "pipoca-admins",
    ...more,
  };
}

async function addProvider(
  issuer: string,
  more: Record<string, unknown> = {},
): Promise<string> {
  const added = await api(
    "POST",
    "/api/plugins/oidc/providers",
    await pedro(),
    providerInput(issuer, more),
  );

  expect(added.status).toBe(201);

  return ((await added.json()) as { id: string }).id;
}

async function configure(more: Record<string, unknown>): Promise<Response> {
  const saved = await api(
    "POST",
    `/api/plugins/oidc/providers/${providerId}`,
    await pedro(),
    providerInput(provider.issuer, more),
  );

  expect(saved.status).toBe(200);

  return saved;
}

async function userOf(cookie: string): Promise<unknown> {
  const status = (await (await api("GET", "/api/auth", cookie)).json()) as {
    user: unknown;
  };

  return status.user;
}

function cookieOf(response: Response): string {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

// Walks a browser through the provider and back. Returns the callback's
// answer and the Cookie header it would send next.
async function signIn(
  account: Account,
  options: { start?: string; cookie?: string; browser?: string } = {},
): Promise<{ readonly response: Response; readonly cookie: string }> {
  const started = await fetch(
    new URL(
      options.start ?? `/api/plugins/oidc/start/${providerId}`,
      server.url,
    ),
    { redirect: "manual", headers: { cookie: options.cookie ?? "" } },
  );

  expect(started.status).toBe(302);

  provider.next = account;

  const authorized = await fetch(started.headers.get("location") ?? "", {
    redirect: "manual",
  });

  const browser = options.browser ?? cookieOf(started);

  const response = await fetch(authorized.headers.get("location") ?? "", {
    redirect: "manual",
    headers: { cookie: browser },
  });

  return { response, cookie: cookieOf(response) };
}

const ana: Account = {
  sub: "P000001",
  email: "ana@example.com",
  groups: ["pipoca-users"],
};

test("offers the provider on the sign-in page once it is set up", async () => {
  const status = (await (
    await fetch(new URL("/api/auth", server.url))
  ).json()) as {
    logins: unknown;
  };

  expect(status.logins).toEqual([
    {
      label: "Sign in with IAS",
      path: `/api/plugins/oidc/start/${providerId}`,
    },
  ]);
});

test("offers a button for each provider and signs in through any of them", async () => {
  const google = fakeProvider();

  try {
    const googleId = await addProvider(google.issuer, {
      label: "Sign in with Google",
      allowedDomains: ["example.com"],
    });

    const status = (await (
      await fetch(new URL("/api/auth", server.url))
    ).json()) as { logins: { label: string }[] };

    google.next = { ...ana, sub: "google-ana", email_verified: true };

    const started = await fetch(
      new URL(`/api/plugins/oidc/start/${googleId}`, server.url),
      { redirect: "manual" },
    );

    const authorized = await fetch(started.headers.get("location") ?? "", {
      redirect: "manual",
    });

    const back = await fetch(authorized.headers.get("location") ?? "", {
      redirect: "manual",
      headers: { cookie: cookieOf(started) },
    });

    expect(status.logins.map(({ label }) => label)).toEqual([
      "Sign in with IAS",
      "Sign in with Google",
    ]);

    expect(started.headers.get("location")).toStartWith(google.issuer);

    expect(await userOf(cookieOf(back))).toMatchObject({
      name: "ana@example.com",
    });
  } finally {
    await google.stop();
  }
});

test("keeps a client secret out of the page, sends it to the provider, and takes it away", async () => {
  const set = await configure({ clientSecret: "s3cret value" });
  const file = readFileSync(join(configDir, "pipoca.json"), "utf8");
  const listed = await api("GET", "/api/plugins/oidc/providers", await pedro());

  await signIn(ana);
  const kept = await configure({ clientSecret: "" });
  await signIn(ana);
  const removed = await configure({ clientSecret: null });
  await signIn(ana);

  const basic = `Basic ${Buffer.from(`${clientId}:s3cret+value`).toString("base64")}`;

  expect(await set.json()).toMatchObject({ hasClientSecret: true });
  expect(await listed.text()).not.toContain("s3cret");
  expect(file).not.toContain("s3cret");
  expect(await kept.json()).toMatchObject({ hasClientSecret: true });
  expect(await removed.json()).toMatchObject({ hasClientSecret: false });

  expect(provider.tokenRequests).toEqual([
    { authorization: basic, clientId: null, verified: true },
    { authorization: basic, clientId: null, verified: true },
    { authorization: null, clientId, verified: true },
  ]);
});

test("lets only admins see and change providers", async () => {
  const { cookie } = await signIn(ana);

  const statuses = [
    (await api("GET", "/api/plugins/oidc/providers", cookie)).status,
    (
      await api(
        "POST",
        "/api/plugins/oidc/providers",
        cookie,
        providerInput(provider.issuer),
      )
    ).status,
    (await api("DELETE", `/api/plugins/oidc/providers/${providerId}`, cookie))
      .status,
  ];

  expect(statuses).toEqual([403, 403, 403]);
});

test("refuses a provider without an issuer URL or a client ID", async () => {
  const statuses = await Promise.all(
    [{ issuer: "not a url" }, { clientId: "" }].map(
      async (more) =>
        (
          await api(
            "POST",
            "/api/plugins/oidc/providers",
            await pedro(),
            providerInput(provider.issuer, more),
          )
        ).status,
    ),
  );

  expect(statuses).toEqual([400, 400]);
});

test("stops offering a provider once it is removed", async () => {
  const removed = await api(
    "DELETE",
    `/api/plugins/oidc/providers/${providerId}`,
    await pedro(),
  );

  const status = (await (
    await fetch(new URL("/api/auth", server.url))
  ).json()) as { logins: unknown[] };

  const start = await fetch(
    new URL(`/api/plugins/oidc/start/${providerId}`, server.url),
    { redirect: "manual" },
  );

  expect([removed.status, status.logins, start.status]).toEqual([200, [], 404]);
});

function configFile(): unknown {
  return JSON.parse(readFileSync(join(configDir, "pipoca.json"), "utf8"));
}

function writeConfig(settings: unknown): void {
  writeFileSync(join(configDir, "pipoca.json"), JSON.stringify(settings));
}

// Starts the server again on the same config folder and database.
async function restart(database = ":memory:"): Promise<void> {
  await server.stop();

  server = serve({
    port: 0,
    database,
    configDir,
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  pedro = firstUser(server, logs);
}

test("keeps the providers Settings adds in pipoca.json", () => {
  expect(configFile()).toEqual({
    oidc: {
      providers: [
        {
          id: "ias",
          label: "Sign in with IAS",
          issuer: provider.issuer,
          clientId,
          accessGroup: "pipoca-users",
          adminGroup: "pipoca-admins",
        },
      ],
    },
  });
});

test("moves a config file under the product's old name to pipoca.json", async () => {
  const settings = configFile();
  renameSync(join(configDir, "pipoca.json"), join(configDir, "pi-cloud.json"));

  await restart();

  expect([configFile(), existsSync(join(configDir, "pi-cloud.json"))]).toEqual([
    settings,
    false,
  ]);
});

test("signs in through a provider written into the file by hand, with its secret from the environment", async () => {
  process.env["PIPOCA_TEST_OIDC_SECRET"] = "from the env";

  const file = configFile() as { oidc: { providers: unknown[] } };

  writeConfig({
    ...file,
    oidc: {
      providers: [
        ...file.oidc.providers,
        {
          ...providerInput(provider.issuer, { label: "Sign in with SAP" }),
          id: "sap",
          clientSecretEnv: "PIPOCA_TEST_OIDC_SECRET",
        },
      ],
    },
  });

  const status = (await (
    await fetch(new URL("/api/auth", server.url))
  ).json()) as { logins: unknown };

  const { cookie } = await signIn(ana, {
    start: "/api/plugins/oidc/start/sap",
  });

  const listed = await api("GET", "/api/plugins/oidc/providers", await pedro());

  expect(status.logins).toEqual([
    { label: "Sign in with IAS", path: "/api/plugins/oidc/start/ias" },
    { label: "Sign in with SAP", path: "/api/plugins/oidc/start/sap" },
  ]);

  expect(await userOf(cookie)).toMatchObject({ name: "ana@example.com" });

  expect(provider.tokenRequests).toEqual([
    {
      authorization: `Basic ${Buffer.from(`${clientId}:from+the+env`).toString("base64")}`,
      clientId: null,
      verified: true,
    },
  ]);

  expect(await listed.json()).toContainEqual(
    expect.objectContaining({
      id: "sap",
      hasClientSecret: true,
      clientSecretEnv: "PIPOCA_TEST_OIDC_SECRET",
    }),
  );

  expect(process.env["PIPOCA_TEST_OIDC_SECRET"]).toBeUndefined();
});

test("fails the plugin, with the reason, when the file's providers don't fit at start", async () => {
  writeConfig({
    oidc: {
      providers: [
        { ...providerInput(provider.issuer), id: "ias", clientSecret: "x" },
      ],
    },
  });

  await restart();

  const listed = (await (
    await api("GET", "/api/plugins", await pedro())
  ).json()) as { id: string; state: string; error?: string }[];

  expect(listed.find(({ id }) => id === "oidc")).toMatchObject({
    state: "failed",
    error:
      "oidc.providers[0]: clientSecret must be sealed by Settings; name an environment variable in clientSecretEnv instead",
  });
});

test("keeps the last providers that fit while the file is broken, and won't overwrite it", async () => {
  writeFileSync(join(configDir, "pipoca.json"), "{ not json");

  const status = (await (
    await fetch(new URL("/api/auth", server.url))
  ).json()) as { logins: unknown[] };

  const added = await api(
    "POST",
    "/api/plugins/oidc/providers",
    await pedro(),
    providerInput(provider.issuer, { label: "Sign in with Google" }),
  );

  expect(status.logins).toHaveLength(1);
  expect(added.status).toBe(400);

  expect(readFileSync(join(configDir, "pipoca.json"), "utf8")).toBe(
    "{ not json",
  );

  expect(logs.some((line) => line.startsWith("config file unreadable"))).toBe(
    true,
  );
});

test("won't save over providers edited by hand into a list that doesn't fit", async () => {
  writeConfig({
    oidc: {
      providers: [
        { ...providerInput(provider.issuer), id: "ias", clientSecret: "x" },
      ],
    },
  });

  const edited = readFileSync(join(configDir, "pipoca.json"), "utf8");

  const added = await api(
    "POST",
    "/api/plugins/oidc/providers",
    await pedro(),
    providerInput(provider.issuer, { label: "Sign in with Google" }),
  );

  expect(added.status).toBe(400);

  expect(await added.json()).toEqual({
    error: "bad_request",
    message:
      "fix oidc in pipoca.json first: oidc.providers[0]: clientSecret must be sealed by Settings; name an environment variable in clientSecretEnv instead",
  });

  expect(readFileSync(join(configDir, "pipoca.json"), "utf8")).toBe(edited);
});

test("moves the providers of the table from before the config file into it", async () => {
  const database = join(configDir, "server.db");
  const db = new DatabaseSync(database);

  db.exec(
    "create table oidc_providers (id text primary key, label text not null, issuer text not null, client_id text not null, client_secret text, groups_claim text not null, access_group text not null, admin_group text not null, allowed_emails text not null, allowed_domains text not null, admin_emails text not null, created_at text not null)",
  );

  db.prepare(
    "insert into oidc_providers values (?, ?, ?, ?, null, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "old-id",
    "Sign in with Okta",
    provider.issuer,
    clientId,
    "groups",
    "pipoca-users",
    "",
    "[]",
    "[]",
    "[]",
    new Date().toISOString(),
  );

  db.close();

  await restart(database);

  const status = (await (
    await fetch(new URL("/api/auth", server.url))
  ).json()) as { logins: { label: string }[] };

  expect(status.logins.map(({ label }) => label)).toEqual([
    "Sign in with IAS",
    "Sign in with Okta",
  ]);

  await restart(database);

  expect(
    (configFile() as { oidc: { providers: unknown[] } }).oidc.providers,
  ).toHaveLength(2);
});

test("makes a user for a member of the access group and signs them in", async () => {
  const { response, cookie } = await signIn(ana);

  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toMatch(/SameSite=Strict/);
  expect(await response.text()).toContain('content="0;url=/"');

  const again = await signIn(ana);

  const users = await Promise.all(
    [cookie, again.cookie].map(async (each) => {
      const status = (await (await api("GET", "/api/auth", each)).json()) as {
        user: unknown;
      };

      return status.user;
    }),
  );

  expect(users[0]).toEqual({
    id: expect.any(String) as string,
    name: "ana@example.com",
    admin: false,
  });

  expect(users[1]).toEqual(users[0]);
});

test("names a user it makes without the spaces around the provider's email", async () => {
  const { cookie } = await signIn({ ...ana, email: " ana@example.com " });

  const status = (await (await api("GET", "/api/auth", cookie)).json()) as {
    user: unknown;
  };

  expect(status.user).toMatchObject({ name: "ana@example.com" });
});

test("refuses someone outside the access group", async () => {
  const { response, cookie } = await signIn({ ...ana, groups: ["others"] });

  expect(response.status).toBe(403);
  expect(await response.text()).toContain("Ask its admin to add you");
  expect(cookie).toBe("");
});

test("lets in verified emails and domains for a provider without groups", async () => {
  await configure({
    allowedEmails: ["Bea@Gmail.com"],
    allowedDomains: ["example.org"],
    adminEmails: ["boss@example.net"],
  });

  const google = (email: string, verified = true): Account => ({
    sub: `google-${email}`,
    email,
    email_verified: verified,
  });

  const signedIn: unknown[] = [];

  // One at a time, since the provider signs in whoever is next.
  for (const account of [
    google("bea@gmail.com"),
    google("cid@example.org"),
    google("boss@example.net"),
    google("dan@example.org", false),
    google("eve@gmail.com"),
  ]) {
    signedIn.push(await userOf((await signIn(account)).cookie));
  }

  expect(signedIn).toMatchObject([
    { name: "bea@gmail.com", admin: false },
    { name: "cid@example.org", admin: false },
    { name: "boss@example.net", admin: true },
    null,
    null,
  ]);
});

test("reads the groups from the claim the settings name", async () => {
  await configure({ groupsClaim: "roles" });

  const fromGroups = await signIn(ana);

  const fromRoles = await signIn({
    ...ana,
    groups: [],
    roles: ["pipoca-users"],
  });

  expect([fromGroups.response.status, fromRoles.response.status]).toEqual([
    403, 200,
  ]);
});

test("reads the admin group again on every sign-in", async () => {
  const account = { ...ana, groups: ["pipoca-users", "pipoca-admins"] };
  const first = await signIn(account);

  const save = async (cookie: string): Promise<number> =>
    (await api("GET", "/api/plugins/oidc/providers", cookie)).status;

  const asAdmin = await save(first.cookie);

  account.groups = ["pipoca-users"];
  const second = await signIn(account);

  expect([asAdmin, await save(second.cookie)]).toEqual([200, 403]);
});

test("only admins change plugins or restart the server", async () => {
  const { cookie } = await signIn(ana);

  const statuses = [
    (await api("POST", "/api/plugins", cookie, { url: "file:///nowhere" }))
      .status,
    (await api("PATCH", "/api/plugins/oidc", cookie, { settings: {} })).status,
    (await api("DELETE", "/api/plugins/oidc", cookie)).status,
    (await api("POST", "/api/restart", cookie, {})).status,
  ];

  expect(statuses).toEqual([403, 403, 403, 403]);
});

test("only admins change an Environment's Kubernetes settings", async () => {
  const { cookie } = await signIn(ana);

  const { environment } = (await (
    await api("POST", "/api/environments", cookie, { name: "pods" })
  ).json()) as { environment: { id: string } };

  const path = `/api/plugins/kubernetes/environments/${environment.id}`;
  const patch = { spec: { volumes: [{ name: "key", secret: {} }] } };

  const statuses = [
    (await api("GET", path, cookie)).status,
    (await api("POST", path, cookie, { settings: { podPatch: patch } })).status,
    (await api("POST", path, cookie, { settings: null })).status,
    (await api("POST", path, await pedro(), { settings: { podPatch: patch } }))
      .status,
  ];

  expect(statuses).toEqual([200, 403, 403, 200]);
});

test("only admins change model aliases, and anyone changes a Project's goal", async () => {
  const { cookie } = await signIn(ana);

  const { environment } = (await (
    await api("POST", "/api/environments", cookie, { name: "laptop" })
  ).json()) as { environment: { id: string } };

  const project = (await (
    await api("POST", "/api/plugins/projects/projects", cookie, {
      name: "Release",
      repositories: ["https://example.com/app.git"],
    })
  ).json()) as { id: string };

  const aliases = `/api/plugins/models/environments/${environment.id}`;
  const settings = `/api/plugins/projects/projects/${project.id}/settings`;

  const statuses = [
    (await api("POST", aliases, cookie, { aliases: null })).status,
    (await api("POST", aliases, await pedro(), { aliases: null })).status,
    (await api("POST", settings, cookie, { goal: "Ship it" })).status,
  ];

  expect(statuses).toEqual([403, 200, 200]);
});

test("refuses a callback in a browser that didn't start the sign-in", async () => {
  const { response, cookie } = await signIn(ana, { browser: "" });

  expect(response.status).toBe(400);
  expect(cookie).toBe("");
});

test("lets a password user link their account and sign in with it", async () => {
  const linked = await signIn(
    { ...ana, email: "pedro@example.com" },
    { start: `/api/plugins/oidc/link/${providerId}`, cookie: await pedro() },
  );

  expect(await linked.response.text()).toContain("url=/#settings/oidc");

  const { cookie } = await signIn({ ...ana, email: "pedro@example.com" });

  const status = (await (await api("GET", "/api/auth", cookie)).json()) as {
    user: unknown;
  };

  const account = await api("GET", "/api/plugins/oidc/account", await pedro());

  expect(status.user).toMatchObject({ name: "pedro", admin: true });

  expect(await account.json()).toEqual({
    admin: true,
    providers: [
      { id: providerId, label: "Sign in with IAS", issuer: provider.issuer },
    ],
    identities: [
      {
        issuer: provider.issuer,
        email: "pedro@example.com",
        linkedAt: expect.any(String) as string,
        created: false,
      },
    ],
  });

  const unlinked = await api(
    "DELETE",
    `/api/plugins/oidc/identities/${encodeURIComponent(provider.issuer)}`,
    await pedro(),
  );

  expect(await unlinked.json()).toMatchObject({ identities: [] });
});

test("sends no client secret when none is set, and proves the code with PKCE", async () => {
  await signIn(ana);

  expect(provider.tokenRequests).toEqual([
    { authorization: null, clientId, verified: true },
  ]);
});

test("fails a sign-in with a page while discovery isn't JSON, and discovers again after", async () => {
  provider.broken = true;

  const failed = await fetch(
    new URL(`/api/plugins/oidc/start/${providerId}`, server.url),
    { redirect: "manual" },
  );

  expect(failed.status).toBe(502);
  expect(await failed.text()).toContain("Sign-in failed");

  provider.broken = false;
  const { response } = await signIn(ana);

  expect(response.status).toBe(200);
});

test("fails a sign-in with a page when the token endpoint can't be reached", async () => {
  const started = await fetch(
    new URL(`/api/plugins/oidc/start/${providerId}`, server.url),
    { redirect: "manual" },
  );

  const authorized = await fetch(started.headers.get("location") ?? "", {
    redirect: "manual",
  });

  await provider.stop();

  const response = await fetch(authorized.headers.get("location") ?? "", {
    redirect: "manual",
    headers: { cookie: cookieOf(started) },
  });

  expect(response.status).toBe(502);
  expect(await response.text()).toContain("Sign-in failed");
});

test("fails a sign-in with a page when the provider can't be reached", async () => {
  await provider.stop();

  const failed = await fetch(
    new URL(`/api/plugins/oidc/start/${providerId}`, server.url),
    { redirect: "manual" },
  );

  expect(failed.status).toBe(502);

  expect(await failed.text()).toContain(
    `couldn&#39;t reach ${new URL(provider.issuer).host}`,
  );
});

// An OpenID provider that signs in whoever next is.
function fakeProvider(): {
  readonly issuer: string;
  next: Account | undefined;
  // Discovery and the token endpoint answer with a web page instead.
  broken: boolean;
  readonly tokenRequests: unknown[];
  readonly stop: () => Promise<void>;
} {
  const codes = new Map<
    string,
    { account: Account; nonce: string; challenge: string }
  >();

  const state = {
    issuer: "",
    next: undefined as Account | undefined,
    broken: false,
    tokenRequests: [] as unknown[],
    stop: async () => {
      await listener.stop(true);
    },
  };

  const listener = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (state.broken && url.pathname !== "/authorize") {
        return new Response("<h1>Bad gateway</h1>", {
          headers: { "content-type": "text/html" },
        });
      }

      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: state.issuer,
          authorization_endpoint: `${state.issuer}/authorize`,
          token_endpoint: `${state.issuer}/token`,
        });
      }

      if (url.pathname === "/authorize") {
        const code = randomUUID();
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");

        codes.set(code, {
          account: state.next ?? ana,
          nonce: url.searchParams.get("nonce") ?? "",
          challenge: url.searchParams.get("code_challenge") ?? "",
        });

        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");

        return Response.redirect(back.toString(), 302);
      }

      const form = new URLSearchParams(await request.text());
      const issued = codes.get(form.get("code") ?? "");

      const verified =
        createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url") === issued?.challenge;

      state.tokenRequests.push({
        authorization: request.headers.get("authorization"),
        clientId: form.get("client_id"),
        verified,
      });

      if (!verified) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }

      const claims = {
        iss: state.issuer,
        aud: clientId,
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: issued.nonce,
        ...issued.account,
      };

      return Response.json({
        id_token: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`,
      });
    },
  });

  state.issuer = `http://127.0.0.1:${String(listener.port)}`;

  return state;
}
