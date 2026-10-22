import { join } from "node:path";
import type { Assignment, Removal, RemovalReport } from "@pi-cloud/protocol";
import { runProvider, type Log } from "@pi-cloud/providers";
import {
  type HostedSession,
  hostSession,
  hostTerminals,
  listModels,
  type SessionOptions,
} from "@pi-cloud/sessionhost";
import {
  findCheckouts,
  prepareWorkspace,
  removeWorkspace,
} from "@pi-cloud/workspaces";
import {
  httpControlPlane,
  httpSessionStream,
  reportRemoval,
  reportStartFailure,
} from "./client";
import { sessionPluginsNamed } from "./plugins";
import { spawnSession } from "./session-process";

export interface AgentOptions {
  readonly server: string;
  readonly provider: string;
  readonly dataDir: string;
  readonly agentDir: string;
  readonly extensionPaths: readonly string[];
  readonly folders: readonly string[];
  // Models built in this process can't reach a child, so with them Sessions
  // run in the agent's own process. Tests use this with Pi's faux provider.
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
  const removing = new Map<string, Promise<RemovalReport>>();

  const workspaceDir = (sessionId: string): string =>
    join(options.dataDir, "workspaces", sessionId);

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

  const release = (
    sessionId: string,
    generation: number,
  ): Hosted | undefined => {
    const entry = hosted.get(sessionId);
    if (entry?.generation !== generation) {
      return undefined;
    }

    hosted.delete(sessionId);

    return entry;
  };

  const hostAssignment = async (
    assignment: Assignment,
    sessionLog: Log,
  ): Promise<HostedSession | undefined> => {
    const { sessionId, generation } = assignment;

    const fenced = (): void => {
      const entry = release(sessionId, generation);
      if (entry) {
        sessionLog("session fenced", { generation });
        void retire(sessionId, entry);
      }
    };

    await stopping.get(sessionId);
    const report = await removing.get(sessionId);

    // An unarchive can overtake a removal, so the assignment may still name
    // the workspace that removal just deleted.
    const workspace =
      report?.outcome === "removed" ? report.restore : assignment.workspace;

    try {
      const { cwd, checkouts } = await prepareWorkspace(
        workspace,
        {
          dir: workspaceDir(sessionId),
          folders: options.folders,
          mirrors: join(options.dataDir, "mirrors"),
        },
        sessionLog,
      );

      const sessionOptions = {
        cwd,
        checkouts,
        agentDir: options.agentDir,
        sessionDir: join(options.dataDir, "sessions", sessionId),
        extensionPaths: options.extensionPaths,
        systemPrompt: assignment.systemPrompt,
        ...(assignment.model && { model: assignment.model }),
      };

      const stream = httpSessionStream(agent, assignment, sessionLog, fenced);
      const terminals = hostTerminals(cwd, stream, sessionLog);
      if (options.models) {
        const session = await hostSession(
          {
            ...sessionOptions,
            models: options.models,
            firstMessage: assignment.firstMessage,
            plugins: sessionPluginsNamed(assignment.plugins),
          },
          stream,
          sessionLog,
          terminals.open,
        );

        return {
          stop: async () => {
            terminals.close();
            await session.stop();
          },
        };
      }

      const child = await spawnSession(
        { ...agent, assignment, options: sessionOptions },
        sessionLog,
        terminals.open,
      );

      void child.exited.then((code) => {
        terminals.close();
        if (release(sessionId, generation)) {
          sessionLog("session process exited", { code });
        }
      });

      return {
        stop: async () => {
          terminals.close();
          await child.stop();
        },
      };
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

      release(sessionId, generation);

      return undefined;
    }
  };

  const removeSessionWorkspace = async (
    removal: Removal,
    sessionLog: Log,
  ): Promise<RemovalReport> => {
    const { sessionId, workspace, force } = removal;
    await stopping.get(sessionId);

    const report = await removeWorkspace(
      workspace,
      { dir: workspaceDir(sessionId), force },
      sessionLog,
    ).catch((error: unknown): RemovalReport => {
      sessionLog("workspace removal failed", { error: String(error) });

      return { outcome: "kept", reason: String(error) };
    });

    await reportRemoval(agent, sessionId, report).catch((error: unknown) => {
      sessionLog("workspace removal not reported", { error: String(error) });
    });

    return report;
  };

  const sessionLogger =
    (sessionId: string): Log =>
    (message, fields) => {
      log(message, { sessionId, ...fields });
    };

  const models = await listModels({
    agentDir: options.agentDir,
    extensionPaths: options.extensionPaths,
    ...(options.models && { models: options.models }),
  }).catch((error: unknown) => {
    log("models not listed", { error: String(error) });

    return [];
  });

  log("models listed", { count: models.length });

  // The roots and the checkouts found under them, for the UI to suggest.
  const checkouts = await findCheckouts(options.folders);
  log("checkouts found", { count: checkouts.length });

  await runProvider({
    controlPlane: httpControlPlane(agent),
    log,
    signal: options.signal,
    folders: [...new Set([...options.folders, ...checkouts])],
    models,
    running: () =>
      [...hosted].map(([sessionId, { generation }]) => ({
        sessionId,
        generation,
      })),
    start: (assignment) => {
      const { sessionId } = assignment;
      const sessionLog = sessionLogger(sessionId);

      const previous = hosted.get(sessionId);
      if (previous) {
        void retire(sessionId, previous);
      }

      hosted.set(sessionId, {
        generation: assignment.generation,
        session: hostAssignment(assignment, sessionLog),
      });
    },
    unload: ({ sessionId, generation }) => {
      const entry = release(sessionId, generation);
      if (entry) {
        void retire(sessionId, entry);
      }
    },
    remove: (removal) => {
      const { sessionId } = removal;
      if (removing.has(sessionId) || hosted.has(sessionId)) {
        return;
      }

      const removed = removeSessionWorkspace(
        removal,
        sessionLogger(sessionId),
      ).finally(() => {
        removing.delete(sessionId);
      });

      removing.set(sessionId, removed);
    },
  });

  log("stopping sessions", { count: hosted.size });

  await Promise.all(
    [...hosted].map(async ([sessionId, entry]) => retire(sessionId, entry)),
  );

  await Promise.all([...stopping.values(), ...removing.values()]);
}
