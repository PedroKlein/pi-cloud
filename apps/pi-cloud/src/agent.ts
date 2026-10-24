import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Assignment,
  ModelRef,
  Removal,
  RemovalReport,
} from "@pi-cloud/protocol";
import { runProvider, type Log } from "@pi-cloud/providers";
import {
  type HostedSession,
  hostSession,
  hostTerminals,
  modelLister,
  restoreTranscript,
  type SessionOptions,
  syncProfile,
} from "@pi-cloud/sessionhost";
import {
  findCheckouts,
  gitCredentials,
  prepareWorkspace,
  removeWorkspace,
} from "@pi-cloud/workspaces";
import {
  fetchTranscript,
  httpControlPlane,
  httpSessionStream,
  reportRemoval,
  reportStartFailure,
} from "./client";
import { sessionPluginsNamed } from "./plugins";
import { containerSession } from "./container";
import { environmentSetup } from "./setup";
import { spawnSession } from "./session-process";

export interface AgentOptions {
  readonly server: string;
  // The runner's name. It joins the pool of the Environment named here, or
  // of the one named after it (ADR 0032).
  readonly provider: string;
  readonly environment?: string;
  // How many Sessions it runs at once. Absent means no limit.
  readonly capacity?: number;
  readonly dataDir: string;
  readonly extensionPaths: readonly string[];
  readonly folders: readonly string[];
  // The Linux pi-cloud binary that container Sessions run. A Linux runner
  // built as a binary uses itself.
  readonly sessionBinary?: string;
  // Models built in this process can't reach a child, so with them Sessions
  // run in the agent's own process. Tests use this with Pi's faux provider.
  readonly models?: SessionOptions["models"];
  readonly log: Log;
  readonly signal: AbortSignal;
}

const relistMs = 60_000;

interface Hosted {
  readonly generation: number;
  readonly profileId: string;
  readonly session: Promise<HostedSession | undefined>;
}

interface Unreported {
  readonly generation: number;
  readonly force: boolean;
  readonly report: RemovalReport;
}

export async function runAgent(options: AgentOptions): Promise<void> {
  const { log } = options;

  const agent = {
    server: options.server,
    provider: options.provider,
    ...(options.environment !== undefined && {
      environment: options.environment,
    }),
  };

  const hosted = new Map<string, Hosted>();
  const stopping = new Map<string, Promise<void>>();
  const removing = new Map<string, Promise<RemovalReport>>();
  // A second run of a removal finds its workspace gone and can't tell what it
  // held, so a report the server hasn't accepted is kept to send again.
  const unreported = new Map<string, Unreported>();

  const profilesDir = join(options.dataDir, "profiles");

  const workspaceDir = (sessionId: string): string =>
    join(options.dataDir, "workspaces", sessionId);

  const setUp = environmentSetup(
    join(options.dataDir, "setup"),
    log,
    options.signal,
  );

  // The machine's logins, which every Profile uses (ADR 0031).
  const credentials = {
    authPath: join(options.dataDir, "auth.json"),
    modelsPath: join(options.dataDir, "models.json"),
  };

  // The machine's models, and those of providers its Profiles' packages add.
  const listers = new Map<
    string,
    Promise<() => Promise<readonly ModelRef[]>>
  >();

  const addLister = (agentDir: string): boolean => {
    if (listers.has(agentDir)) {
      return false;
    }

    listers.set(
      agentDir,
      modelLister({
        agentDir,
        ...credentials,
        extensionPaths: options.extensionPaths,
        ...(options.models && { models: options.models }),
      }).catch((error: unknown) => {
        log("models not listed", { agentDir, error: String(error) });

        return async (): Promise<readonly ModelRef[]> => Promise.resolve([]);
      }),
    );

    return true;
  };

  if (
    existsSync(join(homedir(), ".pi", "agent", "auth.json")) &&
    !existsSync(credentials.authPath)
  ) {
    log("this machine's model logins now live in the data directory", {
      authPath: credentials.authPath,
      hint: "log in again with /login from any session",
    });
  }

  // Sessions on one Profile share its folder, so its syncs run one at a time.
  const profileSyncs = new Map<string, Promise<unknown>>();

  const syncProfileOf = async (
    { profile }: Assignment,
    sessionLog: Log,
  ): Promise<string> => {
    const dir = join(profilesDir, profile.id);

    const synced = (profileSyncs.get(profile.id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => syncProfile(dir, profile, sessionLog));

    profileSyncs.set(profile.id, synced);
    await synced;

    if (addLister(dir)) {
      void relist();
    }

    return dir;
  };

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

    const report =
      (await removing.get(sessionId)) ?? unreported.get(sessionId)?.report;

    if (hosted.get(sessionId)?.generation !== generation) {
      return undefined;
    }

    // An unarchive can overtake a removal or its report, so the assignment
    // may still name the workspace that removal deleted.
    const workspace =
      report?.outcome === "removed" ? report.restore : assignment.workspace;

    try {
      const agentDir = await syncProfileOf(assignment, sessionLog);
      const environment = assignment.environment.variables;

      const variables = {
        ...environment,
        ...gitCredentials(environment, { ...process.env, ...environment }),
      };

      const image = await setUp({ ...assignment.environment, variables });

      const { cwd, checkouts } = await prepareWorkspace(
        workspace,
        {
          dir: workspaceDir(sessionId),
          folders: options.folders,
          mirrors: join(options.dataDir, "mirrors"),
          remoteEnv: gitCredentials(environment, process.env),
        },
        sessionLog,
      );

      // A long clone can outlast the attempt, such as when the runner lost
      // its lease meanwhile.
      if (hosted.get(sessionId)?.generation !== generation) {
        return undefined;
      }

      const sessionDir = join(options.dataDir, "sessions", sessionId);

      const restored = await restoreTranscript(sessionDir, cwd, async () =>
        fetchTranscript(agent, sessionId),
      );

      if (restored > 0) {
        sessionLog("transcript restored from the server", { lines: restored });
      }

      const sessionOptions = {
        cwd,
        checkouts,
        agentDir,
        ...credentials,
        sessionDir,
        extensionPaths: options.extensionPaths,
        systemPrompt: assignment.systemPrompt,
        trusted: assignment.trusted ?? null,
        ...(assignment.model && { model: assignment.model }),
        ...(assignment.thinking && { thinking: assignment.thinking }),
      };

      const stream = httpSessionStream(agent, assignment, sessionLog, fenced);

      const container =
        image === undefined
          ? undefined
          : await containerSession({
              sessionId,
              generation,
              image,
              binary: sessionBinary(options.sessionBinary),
              folders: options.folders,
              session: sessionOptions,
              variables,
            });

      const terminals = hostTerminals(
        {
          cwd,
          variables,
          ...(container && { command: container.shell }),
        },
        stream,
        sessionLog,
      );

      if (options.models && !container) {
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
        {
          ...agent,
          assignment: {
            ...assignment,
            environment: { ...assignment.environment, variables },
          },
          options: sessionOptions,
        },
        sessionLog,
        terminals.open,
        container,
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
    const { sessionId, generation, workspace, force } = removal;
    await stopping.get(sessionId);

    const held = unreported.get(sessionId);
    const again = held?.generation === generation && held.force === force;
    if (again) {
      sessionLog("resending workspace removal report", { generation });
    }

    const report = again
      ? held.report
      : await removeWorkspace(
          workspace,
          { dir: workspaceDir(sessionId), force, folders: options.folders },
          sessionLog,
        ).catch((error: unknown): RemovalReport => {
          sessionLog("workspace removal failed", { error: String(error) });

          return { outcome: "kept", reason: String(error) };
        });

    unreported.set(sessionId, { generation, force, report });

    await reportRemoval(agent, sessionId, { ...report, generation }).then(
      () => {
        unreported.delete(sessionId);
      },
      (error: unknown) => {
        sessionLog("workspace removal not reported", { error: String(error) });
      },
    );

    return report;
  };

  const sessionLogger =
    (sessionId: string): Log =>
    (message, fields) => {
      log(message, { sessionId, ...fields });
    };

  let models: readonly ModelRef[] = [];

  const relist = async (): Promise<void> => {
    const lists = await Promise.all(
      [...listers.values()].map(async (lister) =>
        (await lister)().catch((error: unknown) => {
          log("models not listed", { error: String(error) });

          return [];
        }),
      ),
    );

    const listed = [
      ...new Map(
        lists.flat().map((model) => [`${model.provider}/${model.id}`, model]),
      ).values(),
    ];

    if (listed.length !== models.length) {
      log("models listed", { count: listed.length });
    }

    models = listed;
  };

  const profileDirs = await readdir(profilesDir).catch(() => []);

  for (const dir of [
    join(options.dataDir, "models"),
    ...profileDirs.map((id) => join(profilesDir, id)),
  ]) {
    addLister(dir);
  }

  await relist();

  // A login in any of its Sessions adds models to the machine (ADR 0024).
  const relisting = setInterval(() => {
    void relist();
  }, relistMs);

  options.signal.addEventListener("abort", () => {
    clearInterval(relisting);
  });

  // The roots and the checkouts found under them, for the UI to suggest.
  const checkouts = await findCheckouts(options.folders);
  log("checkouts found", { count: checkouts.length });

  let pruning = Promise.resolve();

  // A Profile deleted on the server leaves its folder here until no Session
  // uses it. A stopping Session may still, so pruning waits for it.
  const pruneProfiles = async (kept: readonly string[]): Promise<void> => {
    if (stopping.size > 0) {
      return;
    }

    const used = new Set(
      [...hosted.values()].map(({ profileId }) => profileId),
    );

    const gone = (await readdir(profilesDir).catch(() => [])).filter(
      (id) => !kept.includes(id) && !used.has(id),
    );

    for (const id of gone) {
      const dir = join(profilesDir, id);
      listers.delete(dir);
      await rm(dir, { recursive: true, force: true });
      log("deleted profile folder removed", { profileId: id });
    }

    if (gone.length > 0) {
      await relist();
    }
  };

  await runProvider({
    controlPlane: httpControlPlane(agent),
    log,
    signal: options.signal,
    folders: [...new Set([...options.folders, ...checkouts])],
    ...(options.capacity !== undefined && { capacity: options.capacity }),
    models: () => models,
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
        profileId: assignment.profile.id,
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
    profiles: (kept) => {
      pruning = pruning
        .then(async () => pruneProfiles(kept))
        .catch((error: unknown) => {
          log("profile folders not pruned", { error: String(error) });
        });
    },
  });

  log("stopping sessions", { count: hosted.size });

  await Promise.all(
    [...hosted].map(async ([sessionId, entry]) => retire(sessionId, entry)),
  );

  await Promise.all([...stopping.values(), ...removing.values(), pruning]);
}

function sessionBinary(configured: string | undefined): string {
  if (configured !== undefined) {
    return configured;
  }

  if (
    process.platform === "linux" &&
    import.meta.dirname.startsWith("/$bunfs")
  ) {
    return process.execPath;
  }

  throw new Error(
    "container Sessions need a Linux pi-cloud binary: start the agent with --session-binary",
  );
}
