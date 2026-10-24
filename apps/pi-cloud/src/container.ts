import { mkdir } from "node:fs/promises";
import { join } from "node:path";

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
// with glibc, bash and git, as the runner's user. Paths are mounted at the
// same place, so the Session's spec needs no rewriting (ADR 0032).
export async function containerSession(options: {
  readonly sessionId: string;
  readonly generation: number;
  readonly image: string;
  readonly binary: string;
  readonly dataDir: string;
  readonly folders: readonly string[];
  readonly cwd: string;
  readonly variables: Readonly<Record<string, string>>;
}): Promise<ContainerSession> {
  const name = `pi-session-${options.sessionId}-${String(options.generation)}`;
  const home = join(options.dataDir, "container-home");
  await mkdir(home, { recursive: true });

  const mounts = [
    ...new Set([options.dataDir, ...options.folders, options.cwd]),
  ];

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
      ...mounts.flatMap((path) => ["-v", `${path}:${path}`]),
      "-v",
      `${options.binary}:${binaryInContainer}:ro`,
      "-w",
      options.cwd,
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
      options.cwd,
      name,
      "bash",
      "-i",
    ],
  };
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
