#!/usr/bin/env bun
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./agent";
import { stderrLog } from "./log";
import { serve } from "./serve";

const usage = `usage:
  pi-cloud server [--port 7420] [--database ~/.pi-cloud/server.db]
                  [--provider <name> [--data-dir ~/.pi-cloud/server]
                  [--extension <path>]...]
  pi-cloud agent --name <provider> [--server http://127.0.0.1:7420]
                 [--data-dir ~/.pi-cloud/agent] [--extension <path>]...`;

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
        extension: { type: "string", multiple: true, default: [] },
      },
    });

    const server = serve({
      port: Number(values.port),
      database: values.database,
      ...(values.provider !== undefined && {
        agent: {
          provider: values.provider,
          dataDir: values["data-dir"],
          agentDir: getAgentDir(),
          extensionPaths: values.extension,
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
        extension: { type: "string", multiple: true, default: [] },
      },
    });

    if (values.name === undefined) {
      process.stderr.write(`${usage}\n`);
      process.exit(2);
    }

    await runAgent({
      server: values.server,
      provider: values.name,
      dataDir: values["data-dir"],
      agentDir: getAgentDir(),
      extensionPaths: values.extension,
      log: stderrLog("agent"),
      signal: shutdown.signal,
    });

    break;
  }

  case undefined:
  default:
    process.stderr.write(`${usage}\n`);
    process.exit(2);
}
