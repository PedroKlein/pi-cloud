#!/usr/bin/env bun
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./agent";
import { stderrLog } from "./log";
import { serve } from "./serve";
import { runSessionProcess } from "./session-process";

const usage = `usage:
  pi-cloud server [--port 7420] [--database ~/.pi-cloud/server.db]
                  [--provider <name> [--data-dir ~/.pi-cloud/server]
                  [--folder <path>]... [--extension <path>]...]
  pi-cloud agent --name <provider> [--server http://127.0.0.1:7420]
                 [--data-dir ~/.pi-cloud/agent] [--folder <path>]...
                 [--extension <path>]...`;

const dataRoot = join(homedir(), ".pi-cloud");
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
        port: { type: "string", default: "7420" },
        database: { type: "string", default: join(dataRoot, "server.db") },
        provider: { type: "string" },
        "data-dir": { type: "string", default: join(dataRoot, "server") },
        folder: { type: "string", multiple: true, default: [] },
        extension: { type: "string", multiple: true, default: [] },
      },
    });

    await checkFolders(values.folder);

    const server = serve({
      port: Number(values.port),
      database: values.database,
      ...(values.provider !== undefined && {
        agent: {
          provider: values.provider,
          dataDir: values["data-dir"],
          agentDir: getAgentDir(),
          extensionPaths: values.extension,
          folders: values.folder,
        },
      }),
      log: stderrLog("server"),
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
        server: { type: "string", default: "http://127.0.0.1:7420" },
        "data-dir": { type: "string", default: join(dataRoot, "agent") },
        folder: { type: "string", multiple: true, default: [] },
        extension: { type: "string", multiple: true, default: [] },
      },
    });

    if (values.name === undefined) {
      process.stderr.write(`${usage}\n`);
      process.exit(2);
    }

    await checkFolders(values.folder);

    await runAgent({
      server: values.server,
      provider: values.name,
      dataDir: values["data-dir"],
      agentDir: getAgentDir(),
      extensionPaths: values.extension,
      folders: values.folder,
      log: stderrLog("agent"),
      signal: shutdown.signal,
    });

    break;
  }

  case "session":
    await runSessionProcess();
    break;

  case undefined:
  default:
    process.stderr.write(`${usage}\n`);
    process.exit(2);
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
