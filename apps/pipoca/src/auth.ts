import type { Joined } from "@pipoca/protocol";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export interface User {
  readonly id: string;
  readonly name: string;
  // Installs, updates and turns on plugins, and changes their settings.
  readonly admin: boolean;
}

export interface StoredUser extends User {
  // Empty for a user who signs in only through a plugin, such as OIDC.
  readonly passwordHash: string;
  readonly createdAt: string;
}

export interface AuthStore {
  readonly userCount: () => number;
  readonly userByName: (name: string) => StoredUser | undefined;
  readonly userById: (id: string) => User | undefined;
  readonly insertUser: (user: StoredUser) => void;
  readonly setAdmin: (id: string, admin: boolean) => void;
  readonly insertBrowserSession: (
    tokenHash: string,
    userId: string,
    expiresAt: string,
  ) => void;
  // Expired browser sessions are left out.
  readonly browserSessionUser: (
    tokenHash: string,
    now: string,
  ) => User | undefined;
  readonly deleteBrowserSession: (tokenHash: string) => void;
  // Also lets go of every runner that joined with the earlier key.
  readonly setEnvironmentKey: (provider: string, keyHash: string) => void;
  // A runner's own token and its Sessions' tokens.
  readonly deleteRunnerTokens: (provider: string, runner: string) => void;
  readonly keyEnvironment: (keyHash: string) => string | undefined;
  // A join key belongs to no Environment until a runner joins with it, and
  // then becomes the key of the Environment made for that runner (ADR 0040).
  readonly insertJoinKey: (keyHash: string) => void;
  readonly hasJoinKey: (keyHash: string) => boolean;
  readonly claimJoinKey: (keyHash: string, provider: string) => void;
  // A Session holds one token, for its current attempt.
  readonly insertAgentToken: (tokenHash: string, holder: Agent) => void;
  readonly agentToken: (tokenHash: string) => Agent | undefined;
  readonly insertMcpToken: (token: McpToken, tokenHash: string) => void;
  readonly mcpTokens: (userId: string) => readonly McpToken[];
  readonly mcpTokenUser: (tokenHash: string) => User | undefined;
  // Whether the user had a token with the id.
  readonly deleteMcpToken: (id: string, userId: string) => boolean;
  // The plugin pages a user pinned in the sidebar, null until they pin or
  // unpin one (ADR 0040).
  readonly pinnedPages: (userId: string) => readonly string[] | null;
  readonly setPinnedPages: (
    userId: string,
    pages: readonly string[] | null,
  ) => void;
}

// A token an MCP client such as Claude Code uses to act as its user
// (ADR 0035). Only its hash is kept.
export interface McpToken {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly createdAt: string;
}

// Who sent a call to /agent/: a runner, or one of its Sessions.
export interface Agent {
  // The provider name of the runner's Environment.
  readonly environment: string;
  readonly runner: string;
  readonly sessionId: string | null;
  // Joined with the Environment's key, so a new key lets it go. Runners a
  // plugin or the server starts got their token without one.
  readonly joined: boolean;
}

export interface AuthStatus {
  readonly user: User | null;
  // No user exists yet, so the setup link creates the first one.
  readonly setup: boolean;
  // Off when people sign in only through a plugin, such as OIDC.
  readonly passwordLogin: boolean;
}

export interface Credentials {
  readonly name: string;
  readonly password: string;
}

export class InvalidCredentials extends Error {}

const cookieName = "pipoca-session";
const sessionDays = 30;
const minPasswordLength = 8;
const maxNameLength = 64;
const maxPasswordLength = 1024;

// Failed sign-ins for a user before it is locked for the rest of the window.
const maxFailures = 10;
const failureWindowMs = 15 * 60_000;

export class Auth {
  readonly #store: AuthStore;
  readonly #failures = new Map<string, { count: number; since: number }>();
  readonly #ownTokens = new Map<string, Agent>();
  #setupToken: string | undefined;
  readonly #passwordLogin: boolean;

  constructor(store: AuthStore, passwordLogin = true) {
    this.#store = store;
    this.#passwordLogin = passwordLogin;

    this.#setupToken =
      store.userCount() === 0
        ? randomBytes(32).toString("base64url")
        : undefined;
  }

  // The one-time token of the first user's setup link (ADR 0034).
  get setupToken(): string | undefined {
    return this.#setupToken;
  }

  userOf(request: Request): User | undefined {
    const token = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(
      cookieName,
    );

    return token === null
      ? undefined
      : this.#store.browserSessionUser(hash(token), new Date().toISOString());
  }

  status(request: Request): AuthStatus {
    return {
      user: this.userOf(request) ?? null,
      setup: this.#store.userCount() === 0,
      passwordLogin: this.#passwordLogin,
    };
  }

  // Undefined when the token is wrong or already used.
  async setUp(
    token: string,
    credentials: Credentials,
  ): Promise<User | undefined> {
    const expected = this.#setupToken;
    if (expected === undefined || !sameText(token, expected)) {
      return undefined;
    }

    checkCredentials(credentials);
    this.#setupToken = undefined;

    try {
      const user: StoredUser = {
        id: randomUUID(),
        name: credentials.name,
        admin: true,
        passwordHash: await Bun.password.hash(credentials.password),
        createdAt: new Date().toISOString(),
      };

      this.#store.insertUser(user);

      return { id: user.id, name: user.name, admin: user.admin };
    } catch (error) {
      this.#setupToken = expected;
      throw error;
    }
  }

  async signIn({
    name,
    password,
  }: Credentials): Promise<User | "wrong" | "locked" | "off"> {
    if (!this.#passwordLogin) {
      return "off";
    }

    if (name.length > maxNameLength || password.length > maxPasswordLength) {
      return "wrong";
    }

    const user = this.#store.userByName(name);

    // An unknown name costs a verify too, so timing doesn't tell names apart.
    if (user === undefined || user.passwordHash === "") {
      await Bun.password.verify(password, await unknownUserHash);

      return "wrong";
    }

    const now = Date.now();
    const seen = this.#failures.get(user.id);

    const failures =
      seen === undefined || now - seen.since > failureWindowMs
        ? { count: 0, since: now }
        : seen;

    if (failures.count >= maxFailures) {
      return "locked";
    }

    // Counted before the verify, so parallel guesses can't all slip past.
    failures.count += 1;
    this.#failures.set(user.id, failures);

    if (!(await Bun.password.verify(password, user.passwordHash))) {
      return "wrong";
    }

    this.#failures.delete(user.id);

    return { id: user.id, name: user.name, admin: user.admin };
  }

  // The key runners join the Environment with, shown only now.
  newEnvironmentKey(provider: string): string {
    const key = `pck_${randomBytes(32).toString("base64url")}`;
    this.#store.setEnvironmentKey(provider, hash(key));

    return key;
  }

  newJoinKey(): string {
    const key = `pck_${randomBytes(32).toString("base64url")}`;
    this.#store.insertJoinKey(hash(key));

    return key;
  }

  // The first runner to join with a join key gets an Environment that
  // newEnvironment makes for it, and the key becomes that Environment's.
  join(
    key: string,
    runner: string,
    newEnvironment: (runner: string) => string,
  ): Joined | undefined {
    if (this.#store.hasJoinKey(hash(key))) {
      this.#store.claimJoinKey(hash(key), newEnvironment(runner));
    }

    const environment = this.#store.keyEnvironment(hash(key));

    return environment === undefined
      ? undefined
      : {
          token: this.#agentToken({
            environment,
            runner,
            sessionId: null,
            joined: true,
          }),
          environment,
        };
  }

  // The server's own runner needs no key, and it and its Sessions stop with
  // the server, so their tokens live only in memory. A new key for its
  // Environment leaves them be.
  ownRunnerToken(environment: string, runner: string): string {
    return this.#agentToken(
      { environment, runner, sessionId: null, joined: false },
      true,
    );
  }

  // For a runner a plugin starts, such as a Kubernetes pod (ADR 0032).
  runnerToken(environment: string, runner: string): string {
    return this.#agentToken({
      environment,
      runner,
      sessionId: null,
      joined: false,
    });
  }

  revokeRunner(environment: string, runner: string): void {
    this.#store.deleteRunnerTokens(environment, runner);
  }

  // The token a Session of the calling runner uses for its current attempt.
  sessionToken(runner: Agent, sessionId: string): string {
    return this.#agentToken(
      { ...runner, sessionId },
      [...this.#ownTokens.values()].includes(runner),
    );
  }

  agentOf(request: Request): Agent | undefined {
    const [scheme, token] = (request.headers.get("authorization") ?? "").split(
      " ",
    );

    if (scheme !== "Bearer" || token === undefined) {
      return undefined;
    }

    const hashed = hash(token);

    return this.#ownTokens.get(hashed) ?? this.#store.agentToken(hashed);
  }

  #agentToken(holder: Agent, own = false): string {
    const token = `pct_${randomBytes(32).toString("base64url")}`;
    const hashed = hash(token);

    if (!own) {
      this.#store.insertAgentToken(hashed, holder);

      return token;
    }

    for (const [previous, { sessionId }] of this.#ownTokens) {
      if (sessionId !== null && sessionId === holder.sessionId) {
        this.#ownTokens.delete(previous);
      }
    }

    this.#ownTokens.set(hashed, holder);

    return token;
  }

  // The secret is shown once, when the token is made.
  newMcpToken(
    userId: string,
    name: string,
  ): { readonly token: McpToken; readonly secret: string } {
    if (name.trim() === "" || name.length > maxNameLength) {
      throw new InvalidCredentials(
        `name must be 1 to ${String(maxNameLength)} characters`,
      );
    }

    const secret = `pcm_${randomBytes(32).toString("base64url")}`;

    const token: McpToken = {
      id: randomUUID(),
      userId,
      name: name.trim(),
      createdAt: new Date().toISOString(),
    };

    this.#store.insertMcpToken(token, hash(secret));

    return { token, secret };
  }

  mcpTokens(userId: string): readonly McpToken[] {
    return this.#store.mcpTokens(userId);
  }

  revokeMcpToken(userId: string, id: string): boolean {
    return this.#store.deleteMcpToken(id, userId);
  }

  pinnedPages(userId: string): readonly string[] | null {
    return this.#store.pinnedPages(userId);
  }

  pinPages(userId: string, pages: readonly string[] | null): void {
    this.#store.setPinnedPages(userId, pages);
  }

  mcpUserOf(request: Request): User | undefined {
    const token = /^bearer\s+(pcm_\S+)$/i.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];

    return token === undefined
      ? undefined
      : this.#store.mcpTokenUser(hash(token));
  }

  userById(id: string): User | undefined {
    return this.#store.userById(id);
  }

  // A user without a password, or undefined when the name is taken.
  createUser(name: string, admin: boolean): User | undefined {
    if (name.trim() === "" || name.length > maxNameLength) {
      throw new InvalidCredentials(
        `name must be 1 to ${String(maxNameLength)} characters`,
      );
    }

    if (this.#store.userByName(name) !== undefined) {
      return undefined;
    }

    const user = { id: randomUUID(), name, admin };

    this.#store.insertUser({
      ...user,
      passwordHash: "",
      createdAt: new Date().toISOString(),
    });

    return user;
  }

  setAdmin(id: string, admin: boolean): void {
    this.#store.setAdmin(id, admin);
  }

  // The Set-Cookie value of a new browser session for the user.
  startSession(user: User, request: Request): string {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + sessionDays * 24 * 60 * 60_000);

    this.#store.insertBrowserSession(
      hash(token),
      user.id,
      expires.toISOString(),
    );

    return new Bun.Cookie(cookieName, token, {
      ...cookieOptions(request),
      maxAge: sessionDays * 24 * 60 * 60,
    }).serialize();
  }

  // The Set-Cookie value that clears the browser's session.
  endSession(request: Request): string {
    const token = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(
      cookieName,
    );

    if (token !== null) {
      this.#store.deleteBrowserSession(hash(token));
    }

    return new Bun.Cookie(cookieName, "", {
      ...cookieOptions(request),
      maxAge: 0,
    }).serialize();
  }
}

const unknownUserHash = Bun.password.hash(randomBytes(16).toString("hex"));

// HTTPS usually ends in a gateway in front of the server (ADR 0034).
function cookieOptions(request: Request): Bun.CookieInit {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure:
      new URL(request.url).protocol === "https:" ||
      request.headers.get("x-forwarded-proto") === "https",
  };
}

function checkCredentials({ name, password }: Credentials): void {
  if (name.trim() === "" || name.length > maxNameLength) {
    throw new InvalidCredentials(
      `name must be 1 to ${String(maxNameLength)} characters`,
    );
  }

  if (
    password.length < minPasswordLength ||
    password.length > maxPasswordLength
  ) {
    throw new InvalidCredentials(
      `password must be ${String(minPasswordLength)} to ${String(maxPasswordLength)} characters`,
    );
  }
}

// A copied database holds no usable browser session.
function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}
