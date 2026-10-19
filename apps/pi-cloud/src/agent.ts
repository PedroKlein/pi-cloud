import { join } from "node:path";
import { runProvider, type Log } from "@pi-cloud/providers";
import {
  type HostedSession,
  hostSession,
  type SessionOptions,
} from "@pi-cloud/sessionhost";
import { httpControlPlane, httpSessionStream } from "./client";

export interface AgentOptions {
  readonly server: string;
  readonly provider: string;
  readonly dataDir: string;
  readonly agentDir: string;
  readonly extensionPaths: readonly string[];
  readonly models?: SessionOptions["models"];
  readonly log: Log;
  readonly signal: AbortSignal;
}

export async function runAgent(options: AgentOptions): Promise<void> {
  const { log } = options;
  const agent = { server: options.server, provider: options.provider };
  const hosted = new Map<string, Promise<HostedSession | undefined>>();

  await runProvider({
    controlPlane: httpControlPlane(agent),
    log,
    signal: options.signal,
    start: (assignment) => {
      const sessionLog: Log = (message, fields) => {
        log(message, { sessionId: assignment.sessionId, ...fields });
      };
      const session = hostSession(
        {
          cwd: assignment.cwd,
          agentDir: options.agentDir,
          sessionDir: join(options.dataDir, "sessions", assignment.sessionId),
          extensionPaths: options.extensionPaths,
          ...(options.models && { models: options.models }),
        },
        httpSessionStream(agent, assignment, sessionLog),
        sessionLog,
      ).catch((error: unknown) => {
        sessionLog("session failed to start", { error: String(error) });
        return undefined;
      });
      hosted.set(assignment.sessionId, session);
    },
  });

  log("stopping sessions", { count: hosted.size });
  await Promise.all(
    [...hosted.values()].map(async (session) => (await session)?.stop()),
  );
}
