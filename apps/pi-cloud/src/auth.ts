import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export interface User {
  readonly id: string;
  readonly name: string;
}

export interface StoredUser extends User {
  readonly passwordHash: string;
  readonly createdAt: string;
}

export interface AuthStore {
  readonly userCount: () => number;
  readonly userByName: (name: string) => StoredUser | undefined;
  readonly insertUser: (user: StoredUser) => void;
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
}

export interface AuthStatus {
  readonly user: User | null;
  // No user exists yet, so the setup link creates the first one.
  readonly setup: boolean;
}

export interface Credentials {
  readonly name: string;
  readonly password: string;
}

export class InvalidCredentials extends Error {}

const cookieName = "pi-cloud-session";
const sessionDays = 30;
const minPasswordLength = 8;
const maxNameLength = 64;
const maxPasswordLength = 1024;

// Failed sign-ins per name before it is locked for the rest of the window.
const maxFailures = 10;
const failureWindowMs = 15 * 60_000;

export class Auth {
  readonly #store: AuthStore;
  readonly #failures = new Map<string, { count: number; since: number }>();
  #setupToken: string | undefined;

  constructor(store: AuthStore) {
    this.#store = store;

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

    const user: StoredUser = {
      id: randomUUID(),
      name: credentials.name,
      passwordHash: await Bun.password.hash(credentials.password),
      createdAt: new Date().toISOString(),
    };

    this.#store.insertUser(user);

    return { id: user.id, name: user.name };
  }

  async signIn({
    name,
    password,
  }: Credentials): Promise<User | "wrong" | "locked"> {
    const failures = this.#failures.get(name);
    const now = Date.now();
    if (failures && now - failures.since > failureWindowMs) {
      this.#failures.delete(name);
    } else if (failures && failures.count >= maxFailures) {
      return "locked";
    }

    const user = this.#store.userByName(name);

    if (
      user === undefined ||
      password.length > maxPasswordLength ||
      !(await Bun.password.verify(password, user.passwordHash))
    ) {
      const counted = this.#failures.get(name) ?? { count: 0, since: now };
      counted.count += 1;
      this.#failures.set(name, counted);

      return "wrong";
    }

    this.#failures.delete(name);

    return { id: user.id, name: user.name };
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
      `password must be at least ${String(minPasswordLength)} characters`,
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
