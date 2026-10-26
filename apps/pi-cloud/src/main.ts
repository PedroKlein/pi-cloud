#!/usr/bin/env bun
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { runAgent } from "./agent";
import { fauxModels } from "./faux";
import { installedPlugins } from "./installed";
import { restartExitCode, supervised } from "./restart";
import { stderrLog } from "./log";
import { parseSecretKey } from "./secret-box";
import { serve } from "./serve";
import { runSessionProcess } from "./session-process";

const usage = `usage:
  [PI_CLOUD_SECRET_KEY=<32 bytes, base64>] \\
  pi-cloud server [--host 127.0.0.1] [--port 7420] [--url <public URL>]
                  [--database ~/.pi-cloud/server.db] [--sso-only]
                  [--plugins <folder next to the database>/plugins]
                  [--config-dir <folder next to the database>/config]
                  [--provider <name> [--data-dir ~/.pi-cloud/server]
                  [--folder <path>]... [--extension <path>]...]
  PI_CLOUD_KEY=<Environment key> | PI_CLOUD_TOKEN=<runner token> \\
  pi-cloud agent --name <runner> [--capacity <n>] [--exit-when-idle <seconds>]
                 [--server http://127.0.0.1:7420] [--session-binary <path>]
                 [--data-dir ~/.pi-cloud/agent] [--folder <path>]...
                 [--extension <path>]... [--session <id>]`;

const dataRoot = join(homedir(), ".pi-cloud");

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
    const secretKey = process.env["PI_CLOUD_SECRET_KEY"];
    delete process.env["PI_CLOUD_SECRET_KEY"];

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
    const key = process.env["PI_CLOUD_KEY"];
    const token = process.env["PI_CLOUD_TOKEN"];
    delete process.env["PI_CLOUD_KEY"];
    delete process.env["PI_CLOUD_TOKEN"];

    const credential = credentialOf(key, token);

    if (
      values.name === undefined ||
      credential === undefined ||
      (capacity !== undefined &&
        !(Number.isSafeInteger(capacity) && capacity > 0)) ||
      (idleSeconds !== undefined &&
        !(Number.isSafeInteger(idleSeconds) && idleSeconds > 0))
    ) {
      process.stderr.write(`${usage}\n`);
      process.exit(2);
    }

    await checkFolders(values.folder);

    const dataDir = absolutePath(values["data-dir"]);
    const fauxReply = process.env["PI_CLOUD_FAUX_REPLY"];

    await runAgent({
      server: values.server,
      provider: values.name,
      credential,
      ...(capacity !== undefined && { capacity }),
      ...(idleSeconds !== undefined && { exitWhenIdleMs: idleSeconds * 1000 }),
      ...(values.session !== undefined && { session: values.session }),
      ...(values["session-binary"] !== undefined && {
        sessionBinary: absolutePath(values["session-binary"]),
      }),
      dataDir,
      extensionPaths: values.extension.map(extensionSource),
      folders: values.folder,
      ...(fauxReply !== undefined && {
        models: await fauxModels(fauxReply, join(dataDir, "faux-auth.json")),
      }),
      log: stderrLog("agent"),
      signal: shutdown.signal,
    });

    break;
  }

  case "session":
    await runSessionProcess();
    break;

  // BROWSER in a Session runs this to hand a URL to its Session host.
  case "open": {
    const [url] = rest;
    const pages = process.env["PI_CLOUD_PAGES"];
    if (url === undefined || pages === undefined) {
      process.stderr.write("usage: pi-cloud open <url>, inside a Session\n");
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
// directory, not against the directory pi-cloud was started from.
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
