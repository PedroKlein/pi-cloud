import { join } from "node:path";
import type { Assignment } from "@pi-cloud/protocol";
import { runProvider, type Log } from "@pi-cloud/providers";
import {
  type HostedSession,
  hostSession,
  type SessionOptions,
} from "@pi-cloud/sessionhost";
import { prepareWorkspace } from "@pi-cloud/workspaces";
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
  readonly folders: readonly string[];
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
  const stopping = new Map<string, Promise<void>>();

  const retire = async (sessionId: string, entry: Hosted): Promise<void> => {
    const stopped = (stopping.get(sessionId) ?? Promise.resolve())
      .then(async () => (await entry.session)?.stop())
      .catch((error: unknown) => {
        log("session failed to stop", { sessionId, error: String(error) });
      })
      .finally(() => {
        if (stopping.get(sessionId) === stopped) {
          stopping.delete(sessionId);
        }
      });

    stopping.set(sessionId, stopped);
    await stopped;
  };

  const start = async (
    assignment: Assignment,
    sessionLog: Log,
  ): Promise<HostedSession | undefined> => {
    const { sessionId, generation } = assignment;

    const current = (): boolean =>
      hosted.get(sessionId)?.generation === generation;

    const fenced = (): void => {
      const entry = hosted.get(sessionId);
      if (entry?.generation === generation) {
        sessionLog("session fenced", { generation });
        hosted.delete(sessionId);
        void retire(sessionId, entry);
      }
    };

    await stopping.get(sessionId);
    try {
      const cwd = await prepareWorkspace(
        assignment.workspace,
        {
          dir: join(options.dataDir, "workspaces", sessionId),
          folders: options.folders,
        },
        sessionLog,
      );

      return await hostSession(
        {
          cwd,
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

      await reportStartFailure(agent, sessionId, {
        generation,
        error: String(error),
      }).catch((reportError: unknown) => {
        sessionLog("start failure not reported", {
          error: String(reportError),
        });
      });

      if (current()) {
        hosted.delete(sessionId);
      }

      return undefined;
    }
  };

  await runProvider({
    controlPlane: httpControlPlane(agent),
    log,
    signal: options.signal,
    folders: options.folders,
    running: () =>
      [...hosted].map(([sessionId, { generation }]) => ({
        sessionId,
        generation,
      })),
    start: (assignment) => {
      const { sessionId } = assignment;

      const sessionLog: Log = (message, fields) => {
        log(message, { sessionId, ...fields });
      };

      const previous = hosted.get(sessionId);
      if (previous) {
        void retire(sessionId, previous);
      }

      hosted.set(sessionId, {
        generation: assignment.generation,
        session: start(assignment, sessionLog),
      });
    },
  });

  log("stopping sessions", { count: hosted.size });

  await Promise.all(
    [...hosted].map(async ([sessionId, entry]) => retire(sessionId, entry)),
  );

  await Promise.all(stopping.values());
}
