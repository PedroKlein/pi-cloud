import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";

const clientId = "pi-cloud-test";

interface Account {
  readonly sub: string;
  readonly email: string;
  groups: string[];
}

let logs: string[];
let server: ReturnType<typeof serve>;
let provider: ReturnType<typeof fakeProvider>;
let pedro: () => Promise<string>;

beforeEach(async () => {
  logs = [];
  provider = fakeProvider();

  server = serve({
    port: 0,
    database: ":memory:",
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  pedro = firstUser(server, logs);

  const saved = await api("PATCH", "/api/plugins/oidc", await pedro(), {
    settings: settings(),
  });

  expect(saved.status).toBe(200);
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

function settings(): Record<string, string> {
  return { issuer: provider.issuer, clientId, label: "Sign in with IAS" };
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
    new URL(options.start ?? "/api/plugins/oidc/start", server.url),
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
  groups: ["pi-cloud-users"],
};

test("offers the provider on the sign-in page once it is set up", async () => {
  const status = (await (
    await fetch(new URL("/api/auth", server.url))
  ).json()) as {
    logins: unknown;
  };

  expect(status.logins).toEqual([
    { label: "Sign in with IAS", path: "/api/plugins/oidc/start" },
  ]);
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

test("refuses someone outside the access group", async () => {
  const { response, cookie } = await signIn({ ...ana, groups: ["others"] });

  expect(response.status).toBe(403);
  expect(await response.text()).toContain("pi-cloud-users");
  expect(cookie).toBe("");
});

test("reads the admin group again on every sign-in", async () => {
  const account = { ...ana, groups: ["pi-cloud-users", "pi-cloud-admins"] };
  const first = await signIn(account);

  const save = async (cookie: string): Promise<number> =>
    (
      await api("PATCH", "/api/plugins/oidc", cookie, {
        settings: settings(),
      })
    ).status;

  const asAdmin = await save(first.cookie);

  account.groups = ["pi-cloud-users"];
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

test("refuses a callback in a browser that didn't start the sign-in", async () => {
  const { response, cookie } = await signIn(ana, { browser: "" });

  expect(response.status).toBe(400);
  expect(cookie).toBe("");
});

test("lets a password user link their account and sign in with it", async () => {
  const linked = await signIn(
    { ...ana, email: "pedro@example.com" },
    { start: "/api/plugins/oidc/link", cookie: await pedro() },
  );

  expect(await linked.response.text()).toContain("url=/#settings");

  const { cookie } = await signIn({ ...ana, email: "pedro@example.com" });

  const status = (await (await api("GET", "/api/auth", cookie)).json()) as {
    user: unknown;
  };

  const identities = await api(
    "GET",
    "/api/plugins/oidc/identities",
    await pedro(),
  );

  expect(status.user).toMatchObject({ name: "pedro", admin: true });

  expect(await identities.json()).toEqual({
    configured: true,
    identities: [
      {
        email: "pedro@example.com",
        linkedAt: expect.any(String) as string,
        created: false,
      },
    ],
  });
});

test("sends no client secret when none is set, and proves the code with PKCE", async () => {
  await signIn(ana);

  expect(provider.tokenRequests).toEqual([
    { authorization: null, clientId, verified: true },
  ]);
});

// An OpenID provider that signs in whoever next is.
function fakeProvider(): {
  readonly issuer: string;
  next: Account | undefined;
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
    tokenRequests: [] as unknown[],
    stop: async () => {
      await listener.stop(true);
    },
  };

  const listener = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);

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
