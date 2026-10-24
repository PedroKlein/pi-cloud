import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { SessionOptions } from "@pi-cloud/sessionhost";

// Where a container Session finds the runner's Linux pi-cloud binary.
const binaryInContainer = "/usr/local/bin/pi-cloud";

export interface ContainerSession {
  readonly name: string;
  // Starts the Session's Pi process in its container, reading the spec on
  // stdin like `pi-cloud session`.
  readonly run: readonly string[];
  readonly kill: readonly string[];
  // A shell in the running container, for the Session's terminals.
  readonly shell: readonly string[];
}

// A container Session runs the runner's own binary, mounted into any image
// with glibc, bash and git, as the runner's user. It sees only what it needs:
// its workspace, the listed folders its worktrees belong to, its Profile
// folder, its own Session folder, the machine's logins and local extensions.
// Paths are mounted at the same place, so the Session's spec needs no
// rewriting (ADR 0032).
export async function containerSession(options: {
  readonly sessionId: string;
  readonly generation: number;
  readonly image: string;
  readonly binary: string;
  readonly folders: readonly string[];
  readonly session: Omit<SessionOptions, "models">;
  readonly variables: Readonly<Record<string, string>>;
}): Promise<ContainerSession> {
  const { session } = options;
  const name = `pi-session-${options.sessionId}-${String(options.generation)}`;
  const home = join(session.sessionDir, "home");
  await mkdir(home, { recursive: true });

  // A bind mount of a missing path fails, so the logins and folders count
  // only once they exist.
  const writable = [
    session.cwd,
    ...(session.checkouts ?? []).map(({ path }) => path),
    session.agentDir,
    session.sessionDir,
    ...(await existing([
      ...options.folders.map(expanded),
      session.authPath,
      session.modelsPath,
    ])),
  ];

  const readOnly = session.extensionPaths.filter(isAbsolute);

  // Values come from the docker client's environment, so they stay out of
  // the process list.
  const variables = [
    ...Object.keys(options.variables).flatMap((key) => ["-e", key]),
    "-e",
    `HOME=${home}`,
  ];

  return {
    name,
    run: [
      "docker",
      "run",
      "-i",
      "--rm",
      "--init",
      ...(process.platform === "linux" ? ["--network", "host"] : []),
      "--name",
      name,
      ...user(),
      ...variables,
      ...[...new Set(writable)].flatMap((path) => bind(path, false)),
      ...[...new Set(readOnly)].flatMap((path) => bind(path, true)),
      ...bind(options.binary, true, binaryInContainer),
      "-w",
      session.cwd,
      "--entrypoint",
      binaryInContainer,
      options.image,
      "session",
    ],
    kill: ["docker", "kill", name],
    shell: [
      "docker",
      "exec",
      "-it",
      ...user(),
      ...variables,
      "-w",
      session.cwd,
      name,
      "bash",
      "-i",
    ],
  };
}

// --mount takes paths with a colon, which -v splits on.
function bind(
  path: string,
  readOnly: boolean,
  target = path,
): readonly string[] {
  return [
    "--mount",
    `type=bind,src=${path},dst=${target}${readOnly ? ",readonly" : ""}`,
  ];
}

function expanded(folder: string): string {
  return resolve(
    folder === "~" || folder.startsWith("~/")
      ? join(homedir(), folder.slice(1))
      : folder,
  );
}

async function existing(paths: readonly string[]): Promise<string[]> {
  const found = await Promise.all(
    paths.map(async (path) =>
      stat(path).then(
        () => path,
        () => undefined,
      ),
    ),
  );

  return found.filter((path) => path !== undefined);
}

function user(): readonly string[] {
  const uid = process.getuid?.();
  const gid = process.getgid?.();

  return uid === undefined || gid === undefined
    ? []
    : ["--user", `${String(uid)}:${String(gid)}`];
}

// Docker Desktop runs containers in a VM, where the runner's own localhost
// is host.docker.internal.
export function serverInContainer(server: string): string {
  if (process.platform === "linux") {
    return server;
  }

  const url = new URL(server);
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    url.hostname = "host.docker.internal";
  }

  return url.href.replace(/\/$/, "");
}
