#!/usr/bin/env bun
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { parseArgs } from "node:util";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { installPackage } from "@pipoca/sessionhost";
import { runAgent } from "./agent";
import { JoinRefused } from "./client";
import { dataFolder } from "./data-folder";
import { fauxModels } from "./faux";
import { installedPlugins } from "./installed";
import { restartExitCode, supervised } from "./restart";
import { stderrLog } from "./log";
import { parseSecretKey } from "./secret-box";
import { serve } from "./serve";
import { runSessionProcess } from "./session-process";

const usage = `usage:
  [PIPOCA_SECRET_KEY=<32 bytes, base64>] \\
  pipoca server [--host 127.0.0.1] [--port 7420] [--url <public URL>]
                  [--database ~/.pipoca/server.db] [--sso-only] [--trust-proxy]
                  [--plugins <folder next to the database>/plugins]
                  [--config-dir <folder next to the database>/config]
                  [--provider <name> [--data-dir ~/.pipoca/server]
                  [--folder <path>]... [--extension <path>]...]
  PIPOCA_KEY=<Environment key> | PIPOCA_TOKEN=<runner token> \\
  pipoca agent [--name <host name>] [--capacity <n>] [--exit-when-idle <seconds>]
                 [--server http://127.0.0.1:7420] [--session-binary <path>]
                 [--data-dir ~/.pipoca/agent] [--folder <the current folder>]...
                 [--extension <path>]... [--session <id>]`;

const dataRoot = dataFolder();

// Pi resolves these sources itself and reads any other one as a local path.
const extensionSourcePrefixes = [
  "npm:",
  "git:",
  "github:",
  "http:",
  "https:",
  "ssh:",
  "builtin:",
  "file:",
];

// Pi imports its OAuth flows through a path a bundler can't follow, so a
// compiled binary would find none of them.
registerBunOAuthFlows();

const [command, ...rest] = process.argv.slice(2);
const shutdown = new AbortController();

// Stay subscribed: signal-exit, which Pi loads, kills the process outright
// when it sees no other handler left for the signal.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdown.abort();
  });
}

switch (command) {
  case "server": {
    const { values } = parseArgs({
      args: rest,
      options: {
        host: { type: "string", default: "127.0.0.1" },
        url: { type: "string" },
        port: { type: "string", default: "7420" },
        database: { type: "string", default: join(dataRoot, "server.db") },
        "sso-only": { type: "boolean", default: false },
        "trust-proxy": { type: "boolean", default: false },
        "config-dir": { type: "string" },
        plugins: { type: "string" },
        provider: { type: "string" },
        "data-dir": { type: "string", default: join(dataRoot, "server") },
        folder: { type: "string", multiple: true, default: [] },
        extension: { type: "string", multiple: true, default: [] },
      },
    });

    await checkFolders(values.folder);

    // Sessions of the built-in runner inherit the environment.
    const secretKey = process.env["PIPOCA_SECRET_KEY"];
    delete process.env["PIPOCA_SECRET_KEY"];

    const log = stderrLog("server");

    const pluginsRoot = absolutePath(
      values.plugins ?? join(dirname(values.database), "plugins"),
    );

    let restarting: Promise<never> | undefined;

    const server = serve({
      hostname: values.host,
      ...(values.url !== undefined && { url: new URL(values.url) }),
      port: Number(values.port),
      database: values.database,
      ...(values["config-dir"] !== undefined && {
        configDir: absolutePath(values["config-dir"]),
      }),
      passwordLogin: !values["sso-only"],
      trustProxy: values["trust-proxy"],
      ...(secretKey !== undefined && { secretKey: parseSecretKey(secretKey) }),
      ...(values.provider !== undefined && {
        agent: {
          provider: values.provider,
          dataDir: absolutePath(values["data-dir"]),
          extensionPaths: values.extension.map(extensionSource),
          folders: values.folder,
        },
      }),
      installed: {
        root: pluginsRoot,
        plugins: await installedPlugins(pluginsRoot, log),
      },
      ...(supervised(process.env) && {
        restart: () => {
          restarting ??= server
            .stop()
            .then(() => process.exit(restartExitCode));
        },
      }),
      log,
    });

    shutdown.signal.addEventListener("abort", () => {
      void server.stop();
    });

    break;
  }

  case "agent": {
    const { values } = parseArgs({
      args: rest,
      options: {
        name: { type: "string" },
        capacity: { type: "string" },
        "exit-when-idle": { type: "string" },
        session: { type: "string" },
        "session-binary": { type: "string" },
        server: { type: "string", default: "http://127.0.0.1:7420" },
        "data-dir": { type: "string", default: join(dataRoot, "agent") },
        folder: { type: "string", multiple: true, default: [] },
        extension: { type: "string", multiple: true, default: [] },
      },
    });

    const capacity =
      values.capacity === undefined ? undefined : Number(values.capacity);

    const idleSeconds =
      values["exit-when-idle"] === undefined
        ? undefined
        : Number(values["exit-when-idle"]);

    // Sessions inherit the environment, and the key would let one join too.
    // A runner a plugin starts, such as a pod, gets a token instead.
    const key = process.env["PIPOCA_KEY"];
    const token = process.env["PIPOCA_TOKEN"];
    delete process.env["PIPOCA_KEY"];
    delete process.env["PIPOCA_TOKEN"];

    const credential = credentialOf(key, token);

    // A machine someone connects by hand runs with its own name and shares
    // the folder it starts in (ADR 0040). A runner a plugin starts names
    // itself and shares nothing it isn't told to.
    const name = values.name ?? (key === undefined ? undefined : hostName());

    const folders =
      values.folder.length > 0 || key === undefined
        ? values.folder
        : [process.cwd()];

    if (
      name === undefined ||
      credential === undefined ||
      (capacity !== undefined &&
        !(Number.isSafeInteger(capacity) && capacity > 0)) ||
      (idleSeconds !== undefined &&
        !(Number.isSafeInteger(idleSeconds) && idleSeconds > 0))
    ) {
      process.stderr.write(`${usage}\n`);
      process.exit(2);
    }

    await checkFolders(folders);

    const dataDir = absolutePath(values["data-dir"]);
    const fauxReply = process.env["PIPOCA_FAUX_REPLY"];

    await runAgent({
      server: values.server,
      provider: name,
      credential,
      ...(capacity !== undefined && { capacity }),
      ...(idleSeconds !== undefined && { exitWhenIdleMs: idleSeconds * 1000 }),
      ...(values.session !== undefined && { session: values.session }),
      ...(values["session-binary"] !== undefined && {
        sessionBinary: absolutePath(values["session-binary"]),
      }),
      dataDir,
      extensionPaths: values.extension.map(extensionSource),
      folders,
      ...(fauxReply !== undefined && {
        models: await fauxModels(fauxReply, join(dataDir, "faux-auth.json")),
      }),
      log: stderrLog("agent"),
      signal: shutdown.signal,
    }).catch((error: unknown) => {
      if (!(error instanceof JoinRefused)) {
        throw error;
      }

      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });

    break;
  }

  case "session":
    await runSessionProcess();
    break;

  // The agent runs this to install a Profile's package with the git logins of
  // the Session's owner, which only this process's environment holds.
  case "install-package": {
    const [dir, source] = rest;
    if (dir === undefined || source === undefined) {
      process.stderr.write("usage: pipoca install-package <dir> <source>\n");
      process.exit(2);
    }

    await installPackage(dir, source).catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exit(1);
    });

    break;
  }

  // BROWSER in a Session runs this to hand a URL to its Session host.
  case "open": {
    const [url] = rest;
    const pages = process.env["PIPOCA_PAGES"];
    if (url === undefined || pages === undefined) {
      process.stderr.write("usage: pipoca open <url>, inside a Session\n");
      process.exit(2);
    }

    const response = await fetch(pages, { method: "POST", body: url });
    process.exitCode = response.ok ? 0 : 1;
    break;
  }

  case undefined:
  default:
    process.stderr.write(`${usage}\n`);
    process.exit(2);
}

// The first label of the host name, in the letters a runner name allows.
function hostName(): string {
  const [label = ""] = hostname().split(".");

  return label.replaceAll(/[^\w-]/g, "-").slice(0, 64) || "machine";
}

function credentialOf(
  key: string | undefined,
  token: string | undefined,
): { readonly key: string } | { readonly token: string } | undefined {
  if (key !== undefined) {
    return { key };
  }

  return token === undefined ? undefined : { token };
}

// A typo in --folder would otherwise only show up as a failed session.
async function checkFolders(folders: readonly string[]): Promise<void> {
  for (const folder of folders) {
    const path = folder.startsWith("~/")
      ? join(homedir(), folder.slice(2))
      : folder;

    const info = await stat(path).catch(() => undefined);
    if (info?.isDirectory() !== true) {
      process.stderr.write(`folder does not exist: ${folder}\n`);
      process.exit(2);
    }
  }
}

// Git and Pi resolve a relative path against a Session's workspace or the home
// directory, not against the directory pipoca was started from.
function absolutePath(path: string): string {
  return resolve(
    path === "~" || path.startsWith("~/")
      ? join(homedir(), path.slice(1))
      : path,
  );
}

function extensionSource(source: string): string {
  return extensionSourcePrefixes.some((prefix) => source.startsWith(prefix))
    ? source
    : absolutePath(source);
}
