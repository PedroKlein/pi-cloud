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
  readonly insertJoinKey: (keyHash: string, ownerId: string) => void;
  // The person whose Environment a runner joining with the key gets.
  readonly joinKeyOwner: (keyHash: string) => string | undefined;
  readonly claimJoinKey: (keyHash: string, provider: string) => void;
  // A Session holds one token, for its current attempt.
  readonly insertAgentToken: (
    tokenHash: string,
    holder: Agent,
    now: string,
  ) => void;
  readonly agentToken: (
    tokenHash: string,
  ) => { readonly agent: Agent; readonly lastUsed: string } | undefined;
  readonly useAgentToken: (tokenHash: string, now: string) => void;
  // Runner tokens last used before the time, and their Sessions' tokens.
  readonly deleteUnusedAgentTokens: (usedBefore: string) => void;
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

interface Failures {
  count: number;
  readonly since: number;
}

const cookieName = "pipoca-session";
const sessionDays = 30;
const runnerTokenDays = 30;
// How stale a token's last use may get before it is written again, so a
// poll seldom writes to the database.
const lastUsedStepMs = 60 * 60_000;
const minPasswordLength = 8;
const maxNameLength = 64;
const maxPasswordLength = 1024;

// Failed sign-ins for a name from one address before the name is locked
// there for the rest of the window, and for any names from one address
// before that address is. A stranger elsewhere can't lock a person out.
const maxFailures = 10;
const maxAddressFailures = 50;
const failureWindowMs = 15 * 60_000;
// Bounds memory when many addresses guess at once; the oldest go first.
const maxTracked = 100_000;

export class Auth {
  readonly #store: AuthStore;
  readonly #failures = new Map<string, Failures>();
  readonly #ownTokens = new Map<string, Agent>();
  #setupToken: string | undefined;
  readonly #passwordLogin: boolean;
  readonly #now: () => number;

  constructor(
    store: AuthStore,
    passwordLogin = true,
    now: () => number = () => Date.now(),
  ) {
    this.#store = store;
    this.#passwordLogin = passwordLogin;
    this.#now = now;

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
    const session = this.browserSessionOf(request);

    return session === undefined ? undefined : this.userOfSession(session);
  }

  // Names the request's browser session without its token, so something
  // that lasts only as long as the session can check it is still there.
  browserSessionOf(request: Request): string | undefined {
    const token = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(
      cookieName,
    );

    return token === null ? undefined : hash(token);
  }

  userOfSession(session: string): User | undefined {
    return this.#store.browserSessionUser(session, new Date().toISOString());
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

  // The address is the client's, as the server or its trusted proxy saw it.
  async signIn(
    { name, password }: Credentials,
    address: string,
  ): Promise<User | "wrong" | "locked" | "off"> {
    if (!this.#passwordLogin) {
      return "off";
    }

    if (name.length > maxNameLength || password.length > maxPasswordLength) {
      return "wrong";
    }

    const now = Date.now();
    this.#prune(now);

    const byAddress = this.#failuresOf(`address\n${address}`, now);
    if (byAddress.count >= maxAddressFailures) {
      return "locked";
    }

    const user = this.#store.userByName(name);

    // An unknown name costs a verify too, so timing doesn't tell names apart.
    if (user === undefined || user.passwordHash === "") {
      byAddress.count += 1;
      await Bun.password.verify(password, await unknownUserHash);

      return "wrong";
    }

    const nameKey = `user\n${user.id}\n${address}`;
    const forName = this.#failuresOf(nameKey, now);
    if (forName.count >= maxFailures) {
      return "locked";
    }

    // Counted before the verify, so parallel guesses can't all slip past.
    byAddress.count += 1;
    forName.count += 1;

    if (!(await Bun.password.verify(password, user.passwordHash))) {
      return "wrong";
    }

    byAddress.count -= 1;
    this.#failures.delete(nameKey);

    return { id: user.id, name: user.name, admin: user.admin };
  }

  // A fresh window goes to the end, so the map stays in the order windows
  // started and pruning stops at the first one still open.
  #failuresOf(key: string, now: number): Failures {
    const seen = this.#failures.get(key);
    if (seen !== undefined && now - seen.since <= failureWindowMs) {
      return seen;
    }

    const fresh = { count: 0, since: now };
    this.#failures.delete(key);
    this.#failures.set(key, fresh);

    return fresh;
  }

  #prune(now: number): void {
    for (const [key, { since }] of this.#failures) {
      if (now - since <= failureWindowMs && this.#failures.size <= maxTracked) {
        return;
      }

      this.#failures.delete(key);
    }
  }

  // The key runners join the Environment with, shown only now.
  newEnvironmentKey(provider: string): string {
    const key = `pck_${randomBytes(32).toString("base64url")}`;
    this.#store.setEnvironmentKey(provider, hash(key));

    return key;
  }

  newJoinKey(ownerId: string): string {
    const key = `pck_${randomBytes(32).toString("base64url")}`;
    this.#store.insertJoinKey(hash(key), ownerId);

    return key;
  }

  // The first runner to join with a join key gets an Environment that
  // environments.create makes for it, and the key becomes that Environment's.
  // A runner is refused the name of one online in the Environment, and takes
  // over the name of one offline, whose tokens stop working (ADR 0032).
  join(
    key: string,
    runner: string,
    environments: {
      readonly create: (runner: string, ownerId: string) => string;
      readonly online: (environment: string, runner: string) => boolean;
    },
  ): Joined | "online" | undefined {
    const owner = this.#store.joinKeyOwner(hash(key));
    if (owner !== undefined) {
      this.#store.claimJoinKey(hash(key), environments.create(runner, owner));
    }

    const environment = this.#store.keyEnvironment(hash(key));
    if (environment === undefined) {
      return undefined;
    }

    if (environments.online(environment, runner)) {
      return "online";
    }

    this.#store.deleteRunnerTokens(environment, runner);

    return {
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

  // A runner token nobody used for runnerTokenDays stops working, and the
  // tokens of that runner's Sessions with it (ADR 0032).
  agentOf(request: Request): Agent | undefined {
    const [scheme, token] = (request.headers.get("authorization") ?? "").split(
      " ",
    );

    if (scheme !== "Bearer" || token === undefined) {
      return undefined;
    }

    const hashed = hash(token);
    const own = this.#ownTokens.get(hashed);
    if (own !== undefined) {
      return own;
    }

    const stored = this.#store.agentToken(hashed);
    if (stored?.agent.sessionId !== null) {
      return stored?.agent;
    }

    const now = this.#now();
    const lastUsed = Date.parse(stored.lastUsed);
    if (now - lastUsed < lastUsedStepMs) {
      return stored.agent;
    }

    const usedBefore = now - runnerTokenDays * 24 * 60 * 60_000;
    const expired = lastUsed < usedBefore;

    if (!expired) {
      this.#store.useAgentToken(hashed, new Date(now).toISOString());
    }

    this.#store.deleteUnusedAgentTokens(new Date(usedBefore).toISOString());

    return expired ? undefined : stored.agent;
  }

  #agentToken(holder: Agent, own = false): string {
    const token = `pct_${randomBytes(32).toString("base64url")}`;
    const hashed = hash(token);

    if (!own) {
      this.#store.insertAgentToken(
        hashed,
        holder,
        new Date(this.#now()).toISOString(),
      );

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
    const trimmed = name.trim();

    if (trimmed === "" || trimmed.length > maxNameLength) {
      throw new InvalidCredentials(
        `name must be 1 to ${String(maxNameLength)} characters`,
      );
    }

    if (this.#store.userByName(trimmed) !== undefined) {
      return undefined;
    }

    const user = { id: randomUUID(), name: trimmed, admin };

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
