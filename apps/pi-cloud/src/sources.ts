import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

// Where an installed plugin came from, and the exact version fetched: a git
// commit, or a tarball's SHA-256 (ADR 0022).
export interface PluginSource {
  readonly url: string;
  readonly pinned: string;
}

const timeoutMs = 2 * 60_000;
const maxTarballBytes = 100 * 1024 * 1024;
const protocols = new Set(["https:", "file:", "ssh:"]);

// Fills the folder `into` with the plugin's files from a git repository, at
// the ref after # or its default branch, or from a .tgz.
export async function fetchSource(url: string, into: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${url} isn't a URL`);
  }

  if (!protocols.has(parsed.protocol)) {
    throw new Error("a plugin installs from an https, ssh or file URL");
  }

  // Every user sees where a plugin came from.
  if (
    parsed.password !== "" ||
    (parsed.username !== "" && parsed.protocol !== "ssh:")
  ) {
    throw new Error(
      "a plugin's URL can't hold credentials; use an ssh URL with a key for a private repository",
    );
  }

  const pinned = /\.(tgz|tar\.gz)$/.test(parsed.pathname)
    ? await fromTarball(parsed, into)
    : await fromGit(parsed, into);

  await refuseLinks(into);

  return pinned;
}

// A link could point the server's own writes and reads, such as the record
// of where the plugin came from, at any file it can reach.
async function refuseLinks(folder: string): Promise<void> {
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  });

  const link = entries.find((entry) => entry.isSymbolicLink());

  if (link !== undefined) {
    throw new Error(
      `it holds a link, ${relative(folder, join(link.parentPath, link.name))}, which a plugin fetched from a URL can't`,
    );
  }
}

async function fromGit(url: URL, into: string): Promise<string> {
  const ref = decodeURIComponent(url.hash.slice(1)) || "HEAD";
  const repository = new URL(url);
  repository.hash = "";

  await mkdir(into);
  await run(["git", "init", "-q"], into);

  await run(
    ["git", "fetch", "-q", "--depth", "1", "--", repository.href, ref],
    into,
  );

  await run(["git", "checkout", "-q", "FETCH_HEAD"], into);

  const pinned = (await run(["git", "rev-parse", "HEAD"], into)).trim();

  await rm(join(into, ".git"), { recursive: true, force: true });

  return pinned;
}

// A tarball holds one folder, as npm pack and GitHub's archives make them.
async function fromTarball(url: URL, into: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

  if (!response.ok) {
    throw new Error(`fetching ${url.href} answered ${String(response.status)}`);
  }

  const bytes = await capped(response);
  const archive = `${into}.tgz`;
  const unpacked = `${into}.unpacked`;

  try {
    await writeFile(archive, bytes);
    await mkdir(unpacked);

    // GNU and BSD tar both refuse members that climb out with .. or through
    // a link the archive made.
    await run(
      [
        "tar",
        "-xzf",
        archive,
        "--no-same-owner",
        "--no-same-permissions",
        "-C",
        unpacked,
      ],
      unpacked,
    );

    const entries = await readdir(unpacked, { withFileTypes: true });
    const [top] = entries;

    if (entries.length !== 1 || top?.isDirectory() !== true) {
      throw new Error("a plugin's tarball holds one folder");
    }

    await rename(join(unpacked, top.name), into);
  } finally {
    await rm(archive, { force: true });
    await rm(unpacked, { recursive: true, force: true });
  }

  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
}

async function capped(response: Response): Promise<Uint8Array> {
  const tooBig = new Error(
    `a plugin's tarball can be at most ${String(maxTarballBytes / 1024 / 1024)} MB`,
  );

  if (Number(response.headers.get("content-length")) > maxTarballBytes) {
    throw tooBig;
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  const reader = response.body?.getReader();

  for (;;) {
    const read = await reader?.read();

    if (read === undefined || read.done) {
      break;
    }

    const chunk = read.value as Uint8Array;

    size += chunk.byteLength;

    if (size > maxTarballBytes) {
      await reader?.cancel();
      throw tooBig;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function run(command: readonly string[], cwd: string): Promise<string> {
  const child = spawned(command, cwd);

  const [code, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (child.signalCode !== null) {
    throw new Error(
      `${command.slice(0, 2).join(" ")} took longer than ${String(timeoutMs / 60_000)} minutes`,
    );
  }

  if (code !== 0) {
    throw new Error(
      `${command.slice(0, 2).join(" ")} failed: ${errors.trim()}`,
    );
  }

  return output;
}

function spawned(
  command: readonly string[],
  cwd: string,
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  try {
    return Bun.spawn([...command], {
      cwd,
      // Nobody is there to answer a password or host key prompt.
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
  } catch {
    throw new Error(`${String(command[0])} isn't installed on this server`);
  }
}
