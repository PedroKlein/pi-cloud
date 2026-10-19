import { join } from "node:path";
import type { Assignment } from "@pi-cloud/protocol";
import { runProvider, type Log } from "@pi-cloud/providers";
import {
  type HostedSession,
  hostSession,
  type SessionOptions,
} from "@pi-cloud/sessionhost";
import {
  httpControlPlane,
  httpSessionStream,
  reportStartFailure,
} from "./client";

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

interface Hosted {
  readonly generation: number;
  readonly session: Promise<HostedSession | undefined>;
}

export async function runAgent(options: AgentOptions): Promise<void> {
  const { log } = options;
  const agent = { server: options.server, provider: options.provider };
  const hosted = new Map<string, Hosted>();
  const stop = async (entry: Hosted | undefined): Promise<void> => {
    await (await entry?.session)?.stop();
  };

  const start = async (
    assignment: Assignment,
    previous: Hosted | undefined,
    sessionLog: Log,
  ): Promise<HostedSession | undefined> => {
    const { sessionId, generation } = assignment;
    const fenced = (): void => {
      const entry = hosted.get(sessionId);
      if (entry?.generation === generation) {
        sessionLog("session fenced", { generation });
        hosted.delete(sessionId);
        void stop(entry);
      }
    };
    await stop(previous);
    try {
      return await hostSession(
        {
          cwd: assignment.cwd,
          agentDir: options.agentDir,
          sessionDir: join(options.dataDir, "sessions", sessionId),
          extensionPaths: options.extensionPaths,
          ...(options.models && { models: options.models }),
        },
        httpSessionStream(agent, assignment, sessionLog, fenced),
        sessionLog,
      );
    } catch (error) {
      sessionLog("session failed to start", { error: String(error) });
      if (hosted.get(sessionId)?.generation === generation) {
        hosted.delete(sessionId);
      }
      await reportStartFailure(agent, sessionId, {
        generation,
        error: String(error),
      }).catch((reportError: unknown) => {
        sessionLog("start failure not reported", {
          error: String(reportError),
        });
      });
      return undefined;
    }
  };

  await runProvider({
    controlPlane: httpControlPlane(agent),
    log,
    signal: options.signal,
    running: () =>
      [...hosted].map(([sessionId, { generation }]) => ({
        sessionId,
        generation,
      })),
    start: (assignment) => {
      const sessionLog: Log = (message, fields) => {
        log(message, { sessionId: assignment.sessionId, ...fields });
      };
      const previous = hosted.get(assignment.sessionId);
      hosted.set(assignment.sessionId, {
        generation: assignment.generation,
        session: start(assignment, previous, sessionLog),
      });
    },
  });

  log("stopping sessions", { count: hosted.size });
  await Promise.all([...hosted.values()].map(stop));
}
