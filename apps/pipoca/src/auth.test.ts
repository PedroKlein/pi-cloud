import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "./serve";
import { setupTokenOf } from "./testdata/sign-in";

let root: string;
let logs: string[];
let server: ReturnType<typeof serve> | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pipoca-auth-"));
  logs = [];
  server = start(":memory:");
});

afterEach(async () => {
  await server?.stop();
  await rm(root, { recursive: true, force: true });
});

function start(
  database: string,
  passwordLogin?: boolean,
): ReturnType<typeof serve> {
  return serve({
    port: 0,
    database,
    ...(passwordLogin !== undefined && { passwordLogin }),
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });
}

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(new URL(path, server?.url), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function get(path: string, cookie?: string): Promise<Response> {
  return fetch(new URL(path, server?.url), {
    headers: cookie === undefined ? {} : { cookie },
  });
}

function cookieOf(response: Response): string {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

const pedro = { name: "pedro", password: "correct horse" };

async function setUp(): Promise<string> {
  return cookieOf(
    await post("/api/auth/setup", { ...pedro, token: setupTokenOf(logs) }),
  );
}

test("creates the first user from the one-time setup link and signs them in", async () => {
  const token = setupTokenOf(logs);

  expect(await (await get("/api/auth")).json()).toEqual({
    user: null,
    setup: true,
    passwordLogin: true,
    logins: [],
  });

  const created = await post("/api/auth/setup", { ...pedro, token });
  const again = await post("/api/auth/setup", { ...pedro, token });

  expect(created.status).toBe(201);

  expect(created.headers.get("set-cookie")).toMatch(
    /^pipoca-session=[\w-]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict$/,
  );

  expect(await (await get("/api/auth", cookieOf(created))).json()).toEqual({
    user: { id: expect.any(String) as string, name: "pedro", admin: true },
    setup: false,
    passwordLogin: true,
    logins: [],
  });

  expect(again.status).toBe(403);
});

test("refuses a setup link with the wrong token or a short password", async () => {
  const wrong = await post("/api/auth/setup", { ...pedro, token: "guess" });

  const short = await post("/api/auth/setup", {
    name: "pedro",
    password: "short",
    token: setupTokenOf(logs),
  });

  expect([wrong.status, short.status]).toEqual([403, 400]);

  expect(await (await get("/api/auth")).json()).toMatchObject({
    setup: true,
  });
});

test("refuses the API and terminals without a signed-in browser", async () => {
  const sessions = await get("/api/sessions");

  const others = [
    (await get("/api/sessions/any/events")).status,
    (await get("/api/profiles")).status,
    (await get("/api/plugins/projects/projects")).status,
    (await post("/api/sessions", {})).status,
  ];

  const terminal = await fetch(
    new URL("/api/sessions/any/terminal", server?.url),
    { headers: { upgrade: "websocket", connection: "Upgrade" } },
  );

  expect([sessions.status, terminal.status, ...others]).toEqual([
    401, 401, 401, 401, 401, 401,
  ]);

  expect(await sessions.json()).toEqual({
    error: "signed_out",
    message: "Sign in again.",
  });

  expect((await get("/healthz")).status).toBe(200);
  expect((await get("/")).status).toBe(200);
});

test("signs in with a password and out again", async () => {
  await setUp();

  const wrong = await post("/api/auth/login", { ...pedro, password: "nope" });
  const unknown = await post("/api/auth/login", { ...pedro, name: "ana" });
  const signedIn = await post("/api/auth/login", pedro);
  const cookie = cookieOf(signedIn);

  expect([wrong.status, unknown.status, signedIn.status]).toEqual([
    401, 401, 200,
  ]);

  expect((await get("/api/sessions", cookie)).status).toBe(200);

  const out = await post("/api/auth/logout", {}, { cookie });

  expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await get("/api/sessions", cookie)).status).toBe(401);
});

test("keeps a user's name without the spaces around it, and signs in with or without them", async () => {
  const created = await post("/api/auth/setup", {
    ...pedro,
    name: " pedro ",
    token: setupTokenOf(logs),
  });

  const signedIn = await Promise.all(
    ["pedro", " pedro "].map(async (name) =>
      post("/api/auth/login", { ...pedro, name }),
    ),
  );

  expect(await created.json()).toMatchObject({ name: "pedro" });
  expect(signedIn.map(({ status }) => status)).toEqual([200, 200]);
});

test("locks a name after repeated failed sign-ins", async () => {
  await setUp();

  for (let attempt = 0; attempt < 10; attempt++) {
    await post("/api/auth/login", { ...pedro, password: "nope" });
  }

  expect((await post("/api/auth/login", pedro)).status).toBe(429);
});

test("locks a name after failed sign-ins sent all at once", async () => {
  await setUp();

  const guesses = await Promise.all(
    Array.from({ length: 30 }, async (_, attempt) =>
      post(
        "/api/auth/login",
        attempt < 29 ? { ...pedro, password: "nope" } : pedro,
      ),
    ),
  );

  expect(guesses.filter(({ status }) => status === 401)).toHaveLength(10);
  expect(guesses.at(-1)?.status).toBe(429);
});

test("doesn't lock a user over failed sign-ins for other names", async () => {
  await setUp();

  for (let attempt = 0; attempt < 10; attempt++) {
    await post("/api/auth/login", { ...pedro, name: "ana" });
  }

  expect((await post("/api/auth/login", pedro)).status).toBe(200);
});

test("marks the cookie Secure behind an HTTPS gateway", async () => {
  await setUp();

  const signedIn = await post("/api/auth/login", pedro, {
    "x-forwarded-proto": "https",
  });

  expect(signedIn.headers.get("set-cookie")).toContain("; Secure");
});

test("logs a new setup link after a restart while there are no users", async () => {
  await server?.stop();
  const database = join(root, "server.db");
  server = start(database);
  const first = setupTokenOf(logs);

  await server.stop();
  server = start(database);

  expect(setupTokenOf(logs)).not.toBe(first);

  const stale = await post("/api/auth/setup", { ...pedro, token: first });

  expect(stale.status).toBe(403);
});

test("keeps users and browser sessions across a restart, with no new setup link", async () => {
  await server?.stop();
  const database = join(root, "server.db");
  server = start(database);
  const cookie = await setUp();

  await server.stop();
  logs = [];
  server = start(database);

  expect(logs.some((line) => line.includes("#setup/"))).toBe(false);
  expect((await get("/api/sessions", cookie)).status).toBe(200);
});

test("refuses passwords when only single sign-on is on, but keeps the setup link", async () => {
  await server?.stop();
  server = start(":memory:", false);

  const created = await post("/api/auth/setup", {
    ...pedro,
    token: setupTokenOf(logs),
  });

  const login = await post("/api/auth/login", pedro);

  expect([created.status, login.status]).toEqual([201, 403]);

  expect(await login.json()).toEqual({
    error: "password_login_off",
    message: "This server doesn't sign people in with a password.",
  });

  expect(await (await get("/api/auth")).json()).toMatchObject({
    passwordLogin: false,
  });
});
