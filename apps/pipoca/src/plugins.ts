import { basename } from "node:path";
import { gitHosts } from "@pipoca/git-hosts/server";
import { kubernetesPlugin } from "@pipoca/kubernetes/server";
import { library } from "@pipoca/library/server";
import { meta } from "@pipoca/meta/server";
import { models } from "@pipoca/models/server";
import { oidc } from "@pipoca/oidc/server";
import { projects } from "@pipoca/projects/server";
import {
  checkedSettings,
  type EventBus,
  type Login,
  type ModelOffer,
  type OfferedModels,
  type PluginConfig,
  type PluginRoute,
  type PluginStore,
  type PublicRoute,
  type RouteCaller,
  type ServerPlugin,
  type ServerPluginContext,
  type ServerTool,
  settingValues,
  type Toolset,
} from "@pipoca/plugins";
import {
  type Actor,
  type Capability,
  capabilities,
  type Command,
  type GitLogin,
  type PluginInfo,
  type PluginManifest,
  type PluginSettings,
  type Session,
  type ToolCall,
  type ToolResult,
  type ToolSpec,
} from "@pipoca/protocol";
import type { Log } from "@pipoca/providers";
import {
  owner,
  type PluginProfile,
  type Result,
  type SessionPlugins,
  type Sessions,
} from "@pipoca/sessions";
import { sessionPlugins } from "./session-parts";
import { runRouteTool, type ToolsetTool, toolsetTools } from "./toolsets";
import type { PluginSettingsStore } from "./store";

export const serverPlugins: readonly ServerPlugin[] = [
  projects,
  library,
  models,
  kubernetesPlugin,
  meta,
  oidc,
  gitHosts,
];

export type UserActor = `user:${string}`;

// Who a toolset tool's request acts as (ADR 0035). A meta-session's acts as
// the user who started it, but never as an admin (ADR 0038).
export interface OnBehalf {
  readonly actor: UserActor;
  readonly mayAdmin: boolean;
}

export interface PluginHost {
  // The plugins that are on, without any that failed to register.
  readonly names: readonly string[];
  readonly list: () => readonly PluginInfo[];
  // The plugin's new settings, what is wrong with them, or undefined when no
  // plugin has the name.
  readonly saveSettings: (
    name: string,
    settings: unknown,
  ) => PluginInfo | string | undefined;
  // Turns an installed plugin on or off for the next start.
  // Turning one on with the digest of the manifest and files the user saw
  // refuses it when its folder changed since.
  readonly turnOn: (
    name: string,
    on: boolean,
    digest?: string,
  ) => Promise<PluginInfo | string | undefined>;
  // Installs a plugin from a git repository or a tarball, turned off.
  readonly install: (url: string) => Promise<PluginInfo | string>;
  // Fetches an installed plugin's newest version for the next start.
  readonly update: (name: string) => Promise<PluginInfo | string | undefined>;
  // Removes an installed plugin that isn't running.
  readonly remove: (name: string) => Promise<boolean | string>;
  // The files of an in-place plugin, which a meta-session writes and builds
  // while it is turned off (ADR 0035). These throw with why they can't.
  readonly files: {
    readonly list: (name: string) => Promise<readonly string[]>;
    readonly read: (name: string, path: string) => Promise<string>;
    readonly write: (
      name: string,
      path: string,
      content: string,
    ) => Promise<PluginInfo>;
    readonly build: (name: string) => Promise<PluginInfo>;
  };
  // The file of a running installed plugin's web part, by its name.
  readonly webPart: (name: string, file: string) => string | undefined;
  // The file of a running installed plugin's Session part, by its hash.
  readonly sessionPart: (name: string, hash: string) => string | undefined;
  readonly sessionPlugins: () => SessionPlugins;
  readonly profile: (id: string) => PluginProfile | undefined;
  readonly profileIds: () => readonly string[];
  readonly tools: (session: Session) => readonly ToolSpec[];
  readonly call: (session: Session, call: ToolCall) => void;
  // Every toolset's tools, and a call to one as a user, for MCP clients.
  readonly toolsetTools: () => readonly ToolSpec[];
  readonly callToolset: (
    name: string,
    input: unknown,
    actor: UserActor,
  ) => Promise<ToolResult>;
  readonly offeredModels: (environmentId: string) => OfferedModels;
  readonly startsRunners: (environmentId: string) => boolean;
  readonly gitLogins: (userId: string) => readonly GitLogin[];
  readonly route: (
    request: Request,
    name: string,
    path: string,
    caller: RouteCaller,
  ) => Promise<Response | undefined>;
  readonly publicRoute: (
    request: Request,
    name: string,
    path: string,
  ) => Promise<Response | undefined>;
  // The links the sign-in page shows besides the password form, each with
  // its path from the server's root.
  readonly logins: () => readonly Login[];
}

function pluginEnvironments(
  sessions: Sessions,
  runners: {
    readonly token: (environment: string, runner: string) => string;
    readonly revoke: (environment: string, runner: string) => void;
  },
  startsRunners: ServerPluginContext["environments"]["startsRunners"],
): ServerPluginContext["environments"] {
  const provider = (environmentId: string): string => {
    const found = sessions
      .environments()
      .find(({ id }) => id === environmentId);

    if (found === undefined) {
      throw new Error(`no Environment ${environmentId}`);
    }

    return found.provider;
  };

  return {
    list: () => sessions.environments(),
    unplaced: (environmentId) => sessions.unplaced(environmentId),
    runnerToken: (environmentId, runner) =>
      runners.token(provider(environmentId), runner),
    revokeRunner: (environmentId, runner) => {
      runners.revoke(provider(environmentId), runner);
    },
    startsRunners,
  };
}

export function startPlugins(
  plugins: readonly ServerPlugin[],
  enabled: readonly string[],
  deps: {
    // What the Plugins page lists, on or not.
    readonly manifests: readonly PluginManifest[];
    readonly sessions: Sessions;
    readonly runners: {
      readonly token: (environment: string, runner: string) => string;
      readonly revoke: (environment: string, runner: string) => void;
    };
    readonly events: EventBus;
    readonly changes: (topic: string) => void;
    readonly store: (name: string) => PluginStore;
    readonly settings: PluginSettingsStore;
    readonly config: (name: string) => PluginConfig;
    // The kernel's own toolsets (ADR 0035).
    readonly toolsets: readonly Toolset[];
    // Handles a toolset tool's request as the user.
    readonly api: (onBehalf: OnBehalf, request: Request) => Promise<Response>;
    readonly auth: Pick<
      ServerPluginContext["auth"],
      "userOf" | "createUser" | "setAdmin" | "startSession"
    >;
    readonly installed?: InstalledPlugins;
    readonly signal: AbortSignal;
    readonly log: Log;
  },
): PluginHost {
  const tools = new Map<string, { plugin: string; tool: ServerTool }>();
  const routeTools = new Map<string, ToolsetTool>();
  const toolsetUsers = new Set<string>();
  const routes = new Map<string, PluginRoute>();
  const publicRoutes = new Map<string, PublicRoute>();
  const logins: { plugin: string; offered: () => readonly Login[] }[] = [];
  const offers: ModelOffer[] = [];
  const gitLogins: ((userId: string) => readonly GitLogin[])[] = [];
  const starters: ((environmentId: string) => boolean)[] = [];

  const failures = new Map<string, string>(
    deps.installed?.plugins.flatMap(({ manifest: { id }, error }) =>
      error === undefined ? [] : [[id, error] as const],
    ),
  );

  const installedIds = new Set(
    deps.installed?.plugins.map(({ manifest: { id } }) => id),
  );

  // What is in the plugins folder now, which installs and updates change
  // before the server restarts.
  let manifests = [...deps.manifests];

  const sources = new Map(
    deps.installed?.plugins.flatMap(({ manifest: { id }, source }) =>
      source === undefined ? [] : [[id, source] as const],
    ),
  );

  const updated = new Set<string>();

  const fileDigests = new Map(
    deps.installed?.plugins.flatMap(({ manifest: { id }, digest }) =>
      digest === undefined ? [] : [[id, digest] as const],
    ),
  );

  const remember = (id: string, digest: string | undefined): void => {
    if (digest === undefined) {
      fileDigests.delete(id);
    } else {
      fileDigests.set(id, digest);
    }
  };

  const folder = (): InstalledPlugins => {
    if (deps.installed === undefined) {
      throw new Error("this server has no plugins folder");
    }

    return deps.installed;
  };

  // Only a plugin turned off changes, since turning one on trusted what it
  // was then.
  const changeable = (name: string): InstalledPlugins => {
    if (listed(name) !== undefined && !installedIds.has(name)) {
      throw new Error(`${name} is a built-in plugin`);
    }

    if (switchedOn.has(name)) {
      throw new Error(
        `${name} is turned on; the user turns it off on the Plugins page before it changes`,
      );
    }

    return folder();
  };

  // Writes, builds, switches and removals go one at a time, so a plugin
  // isn't turned on while a write changes it.
  let changing = Promise.resolve();

  const oneAtATime = async <T>(change: () => Promise<T>): Promise<T> => {
    const next = changing.then(change);

    changing = next.then(
      () => undefined,
      () => undefined,
    );

    return next;
  };

  const turned = async (
    found: PluginManifest,
    on: boolean,
  ): Promise<PluginInfo> => {
    await folder().turnOn(found.id, on);

    if (on) {
      switchedOn.add(found.id);
    } else {
      switchedOn.delete(found.id);
    }

    deps.log("plugin turned on or off", { plugin: found.id, on });

    return info(found);
  };

  // A plugin running until the restart keeps its state; the listing shows
  // what its folder holds now.
  const reread = async (name: string): Promise<PluginInfo> => {
    const read = await folder().reread(name);

    manifests = listed(name)
      ? manifests.map((each) => (each.id === name ? read.manifest : each))
      : [...manifests, read.manifest];

    installedIds.add(name);
    remember(name, read.digest);

    if (!running.includes(name)) {
      if (read.error === undefined) {
        failures.delete(name);
      } else {
        failures.set(name, read.error);
      }
    }

    return info(read.manifest);
  };

  const webParts = new Map(
    deps.installed?.plugins.flatMap(({ manifest: { id }, web }) =>
      web === undefined ? [] : [[id, web] as const],
    ),
  );

  const sessionBundles = new Map(
    deps.installed?.plugins.flatMap(({ manifest: { id }, session }) =>
      session === undefined ? [] : [[id, session] as const],
    ),
  );

  const switchedOn = new Set(
    deps.installed?.plugins.flatMap(({ manifest: { id }, on }) =>
      on ? [id] : [],
    ),
  );

  const profiles = new Map<string, PluginProfile>();
  const loaded = new Map<string, readonly string[]>();

  const listed = (name: string): PluginManifest | undefined =>
    manifests.find(({ id }) => id === name);

  // The version running, whose settings and parts an update changes only
  // when the server restarts.
  const manifest = (name: string): PluginManifest | undefined =>
    listed(name) &&
    (deps.manifests.find(({ id }) => id === name) ?? listed(name));

  const values = (name: string): PluginSettings =>
    settingValues(manifest(name)?.settings, deps.settings.get(name));

  const taken = (name: string): boolean =>
    tools.has(name) || routeTools.has(name);

  // A toolset's namespace has one owner, so its description stays its own.
  const namespaces = new Map<string, string>();

  const claim = (namespace: string, claimant: string): void => {
    const taker = namespaces.get(namespace);
    if (taker !== undefined && taker !== claimant) {
      throw new Error(`toolset ${namespace} belongs to ${taker}`);
    }

    namespaces.set(namespace, claimant);
  };

  for (const { name } of deps.toolsets.map(({ namespace }) => namespace)) {
    claim(name, "kernel");
  }

  for (const tool of deps.toolsets.flatMap((each) => toolsetTools(each))) {
    if (taken(tool.spec.name)) {
      throw new Error(`tool ${tool.spec.name} is already registered`);
    }

    routeTools.set(tool.spec.name, tool);
  }

  const loadsToolsets = (session: Session): boolean =>
    session.owner !== null && toolsetUsers.has(session.owner.plugin);

  for (const plugin of plugins.filter(({ name }) => enabled.includes(name))) {
    const log: Log = (message, fields) => {
      deps.log(message, { plugin: plugin.name, ...fields });
    };

    // What the plugin registers is kept aside until register returns, so a
    // plugin that throws leaves nothing behind in the host (ADR 0036).
    const staged = {
      tools: new Map<string, ServerTool>(),
      routeTools: new Map<string, ToolsetTool>(),
      namespaces: new Set<string>(),
      loadsToolsets: false,
      route: undefined as PluginRoute | undefined,
      publicRoute: undefined as PublicRoute | undefined,
      logins: [] as (() => readonly Login[])[],
      offers: [] as ModelOffer[],
      gitLogins: [] as ((userId: string) => readonly GitLogin[])[],
      starters: [] as ((environmentId: string) => boolean)[],
      profiles: new Map<string, PluginProfile>(),
      loadOnly: undefined as readonly string[] | undefined,
      unsubscribes: [] as (() => void)[],
    };

    const failed = new AbortController();

    const stagedTaken = (name: string): boolean =>
      taken(name) || staged.tools.has(name) || staged.routeTools.has(name);

    const declared = installedIds.has(plugin.name)
      ? (manifest(plugin.name)?.capabilities ?? [])
      : capabilities;

    try {
      plugin.register(
        limited(plugin.name, declared, installedIds.has(plugin.name), {
          owner,
          tools: {
            register: (tool) => {
              if (stagedTaken(tool.name)) {
                throw new Error(`tool ${tool.name} is already registered`);
              }

              staged.tools.set(tool.name, tool);
            },
          },
          toolsets: {
            register: (toolset) => {
              const taker = namespaces.get(toolset.namespace.name);
              if (taker !== undefined && taker !== plugin.name) {
                throw new Error(
                  `toolset ${toolset.namespace.name} belongs to ${taker}`,
                );
              }

              staged.namespaces.add(toolset.namespace.name);

              for (const tool of toolsetTools(toolset, plugin.name)) {
                if (stagedTaken(tool.spec.name)) {
                  throw new Error(
                    `tool ${tool.spec.name} is already registered`,
                  );
                }

                staged.routeTools.set(tool.spec.name, tool);
              }
            },
            loadInOwnSessions: () => {
              staged.loadsToolsets = true;
            },
          },
          events: {
            publish: deps.events.publish,
            subscribe: (type, listener) => {
              const unsubscribe = deps.events.subscribe(type, listener);
              staged.unsubscribes.push(unsubscribe);

              return unsubscribe;
            },
          },
          changes: {
            publish: (name) => {
              deps.changes(`${plugin.name}.${name}`);
            },
          },
          sessions: pluginSessions(deps.sessions, plugin.name, (names) => {
            staged.loadOnly = names;
          }),
          environments: pluginEnvironments(
            deps.sessions,
            deps.runners,
            (starts) => {
              staged.starters.push(starts);
            },
          ),
          profiles: {
            provide: (key, { name: _name, ...content }) => {
              const id = `${plugin.name}.${key}`;

              staged.profiles.set(id, {
                plugin: plugin.name,
                profile: { id, ...content },
              });

              return id;
            },
          },
          routes: {
            handle: (route) => {
              staged.route = route;
            },
          },
          auth: {
            offer: (login) => {
              staged.logins.push(login);
            },
            handlePublic: (route) => {
              staged.publicRoute = route;
            },
            userOf: deps.auth.userOf,
            createUser: deps.auth.createUser,
            setAdmin: deps.auth.setAdmin,
            startSession: deps.auth.startSession,
            gitLogins: (loginsOf) => {
              staged.gitLogins.push(loginsOf);
            },
          },
          models: {
            offer: (offer) => {
              staged.offers.push(offer);
            },
          },
          store: deps.store(plugin.name),
          settings: { get: () => values(plugin.name) },
          config: deps.config(plugin.name),
          signal: AbortSignal.any([deps.signal, failed.signal]),
          log,
        }),
      );
    } catch (error) {
      for (const unsubscribe of staged.unsubscribes) {
        unsubscribe();
      }

      failed.abort();

      const message = error instanceof Error ? error.message : String(error);
      failures.set(plugin.name, message);
      log("plugin failed to register", { error: message });

      continue;
    }

    for (const [name, tool] of staged.tools) {
      tools.set(name, { plugin: plugin.name, tool });
    }

    for (const namespace of staged.namespaces) {
      claim(namespace, plugin.name);
    }

    for (const [name, tool] of staged.routeTools) {
      routeTools.set(name, tool);
    }

    if (staged.loadsToolsets) {
      toolsetUsers.add(plugin.name);
    }

    if (staged.route !== undefined) {
      routes.set(plugin.name, staged.route);
    }

    if (staged.publicRoute !== undefined) {
      publicRoutes.set(plugin.name, staged.publicRoute);
    }

    logins.push(
      ...staged.logins.map((offered) => ({ plugin: plugin.name, offered })),
    );

    offers.push(...staged.offers);
    gitLogins.push(...staged.gitLogins);
    starters.push(...staged.starters);

    for (const [id, profile] of staged.profiles) {
      profiles.set(id, profile);
    }

    if (staged.loadOnly !== undefined) {
      loaded.set(plugin.name, staged.loadOnly);
    }

    deps.log("plugin registered", { plugin: plugin.name });
  }

  const running = enabled.filter((name) => !failures.has(name));

  const info = (found: PluginManifest): PluginInfo => {
    const error = failures.get(found.id);
    const installed = installedIds.has(found.id);
    const source = sources.get(found.id);

    // What is in its folder now, which may wait for a restart to run.
    const base = {
      ...(listed(found.id) ?? found),
      source: installed ? "installed" : "built-in",
      turnedOn: installed
        ? switchedOn.has(found.id)
        : enabled.includes(found.id),
      values: values(found.id),
      digest: new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(listed(found.id) ?? found))
        .update(fileDigests.get(found.id) ?? "")
        .digest("hex"),
      ...(source !== undefined && { installedFrom: source }),
      ...(updated.has(found.id) && { updated: true }),
    } as const;

    if (error !== undefined) {
      return { ...base, state: "failed", error };
    }

    const web = webParts.get(found.id);

    return running.includes(found.id)
      ? {
          ...base,
          state: "on",
          ...(web !== undefined && {
            webPart: `/api/plugin-parts/${found.id}/${basename(web)}`,
          }),
        }
      : { ...base, state: "off" };
  };

  return {
    names: running,
    list: () => manifests.map(info),
    saveSettings: (name, settings) => {
      const found = manifest(name);
      if (found === undefined) {
        return undefined;
      }

      const checked = checkedSettings(found.settings, settings);
      if (typeof checked === "string") {
        return checked;
      }

      deps.settings.set(name, checked);
      deps.log("plugin settings saved", { plugin: name });

      return info(found);
    },
    turnOn: async (name, on, digest) =>
      oneAtATime(async () => {
        const found = manifest(name);
        if (found === undefined) {
          return undefined;
        }

        if (deps.installed === undefined || !installedIds.has(name)) {
          return "only an installed plugin can be turned on or off here";
        }

        const error = failures.get(name);
        if (on && error !== undefined && !switchedOn.has(name)) {
          return `fix its manifest first: ${error}`;
        }

        if (on && digest !== undefined && digest !== info(found).digest) {
          return "it changed since the page showed it; look at it again before turning it on";
        }

        return turned(found, on);
      }),
    install: async (url) => {
      if (deps.installed === undefined) {
        return "this server has no plugins folder";
      }

      try {
        const {
          manifest: found,
          source,
          digest,
        } = await deps.installed.install(
          url,
          (id) => manifest(id) !== undefined,
        );

        manifests = [...manifests, found];
        installedIds.add(found.id);
        remember(found.id, digest);

        if (source !== undefined) {
          sources.set(found.id, source);
        }

        deps.log("plugin installed", { plugin: found.id, ...source });

        return info(found);
      } catch (error) {
        return messageOf(error);
      }
    },
    update: async (name) => {
      const found = manifest(name);
      if (found === undefined) {
        return undefined;
      }

      if (deps.installed === undefined || !installedIds.has(name)) {
        return "only an installed plugin can update";
      }

      try {
        const fetched = await deps.installed.update(name);

        if (fetched === undefined) {
          return info(found);
        }

        manifests = manifests.map((each) =>
          each.id === name ? fetched.manifest : each,
        );

        if (fetched.source !== undefined) {
          sources.set(name, fetched.source);
        }

        remember(name, fetched.digest);

        updated.add(name);

        // Why the version before failed doesn't hold for this one.
        failures.delete(name);

        if (!fetched.on) {
          switchedOn.delete(name);
        }

        deps.log("plugin updated", {
          plugin: name,
          ...fetched.source,
          on: fetched.on,
        });

        return info(fetched.manifest);
      } catch (error) {
        return messageOf(error);
      }
    },
    remove: async (name) =>
      oneAtATime(async () => {
        if (manifest(name) === undefined) {
          return false;
        }

        if (deps.installed === undefined || !installedIds.has(name)) {
          return "only an installed plugin can be removed";
        }

        if (running.includes(name)) {
          return "it is running, so turn it off and restart the server first";
        }

        try {
          await deps.installed.remove(name);
        } catch (error) {
          return messageOf(error);
        }

        manifests = manifests.filter(({ id }) => id !== name);
        installedIds.delete(name);
        switchedOn.delete(name);
        failures.delete(name);
        sources.delete(name);
        updated.delete(name);
        fileDigests.delete(name);

        deps.log("plugin removed", { plugin: name });

        return true;
      }),
    files: {
      list: async (name) => folder().files(name),
      read: async (name, path) => folder().read(name, path),
      write: async (name, path, content) =>
        oneAtATime(async () => {
          await changeable(name).write(name, path, content);
          deps.log("plugin file written", { plugin: name, path });

          return reread(name);
        }),
      build: async (name) =>
        oneAtATime(async () => {
          // The running version's bundles are served from its folder.
          if (running.includes(name)) {
            throw new Error(
              `${name} is running; it builds when the server restarts`,
            );
          }

          await changeable(name).build(name);
          deps.log("plugin built", { plugin: name });

          return reread(name);
        }),
    },
    webPart: (name, file) => {
      const web = webParts.get(name);

      return running.includes(name) &&
        web !== undefined &&
        basename(web) === file
        ? web
        : undefined;
    },
    sessionPart: (name, hash) => {
      const bundle = sessionBundles.get(name);

      return running.includes(name) && bundle?.hash === hash
        ? bundle.path
        : undefined;
    },
    sessionPlugins: () => {
      return {
        plugins: running,
        pluginSettings: Object.fromEntries(
          running.map((name) => [name, values(name)]),
        ),
        ownSessionsOnly: [
          ...sessionPlugins
            .filter(({ ownSessionsOnly: own }) => own === true)
            .map(({ name }) => name),
          ...[...sessionBundles.keys()].filter(
            (name) => manifest(name)?.ownSessionsOnly === true,
          ),
        ],
        loadOnly: Object.fromEntries(loaded),
        installedParts: Object.fromEntries(
          [...sessionBundles]
            .filter(([name]) => running.includes(name))
            .map(([name, { hash }]) => [name, hash]),
        ),
      };
    },
    profile: (id) => profiles.get(id),
    profileIds: () => [...profiles.keys()],
    tools: (session) => [
      ...[...tools.values()]
        .filter(({ tool }) => tool.appliesTo(session))
        .map(({ tool: { appliesTo: _appliesTo, run: _run, ...spec } }) => spec),
      ...(loadsToolsets(session)
        ? [...routeTools.values()].map(({ spec }) => spec)
        : []),
    ],
    call: (session, call) => {
      const actor: Actor = `session:${session.id}`;

      deps.events.publish({
        type: "ToolCalled",
        session,
        tool: call.name,
        actor,
      });

      const routed = loadsToolsets(session)
        ? routeTools.get(call.name)
        : undefined;

      const found = tools.get(call.name);

      const result = async (): Promise<ToolResult> => {
        if (routed !== undefined) {
          return runRouteTool(
            routed,
            call.input,
            {
              actor: `user:${session.startedBy ?? session.ownerId}`,
              mayAdmin: false,
            },
            deps,
            (action) => {
              deps.sessions.publish(session.id, {
                generation: call.generation,
                events: [{ type: "ui_action", action }],
              });
            },
          );
        }

        return found?.tool.appliesTo(session) === true
          ? found.tool.run(call.input, { session, actor })
          : Promise.resolve({
              text: `no tool named ${call.name}`,
              isError: true,
            });
      };

      const plugin = routed === undefined ? found?.plugin : routed.plugin;

      void result()
        .catch((error: unknown) => ({ text: String(error), isError: true }))
        .then((reply) => {
          sendResult(deps, session.id, call, {
            actor: `plugin:${plugin ?? "kernel"}`,
            type: "tool_result",
            id: call.id,
            result: reply,
          });
        });
    },
    toolsetTools: () => [...routeTools.values()].map(({ spec }) => spec),
    callToolset: async (name, input, actor) => {
      const found = routeTools.get(name);

      return found === undefined
        ? { text: `no tool named ${name}`, isError: true }
        : runRouteTool(
            found,
            input,
            { actor, mayAdmin: true },
            deps,
            () => undefined,
          ).catch((error: unknown) => ({ text: String(error), isError: true }));
    },
    offeredModels: (environmentId) => {
      const offered = offers.map((offer) => offer(environmentId));
      const fallback = offered.find((each) => each.default)?.default;

      return {
        models: offered.flatMap((each) => each.models),
        ...(fallback && { default: fallback }),
      };
    },
    startsRunners: (environmentId) =>
      starters.some((starts) => starts(environmentId)),
    gitLogins: (userId) => gitLogins.flatMap((loginsOf) => loginsOf(userId)),
    route: async (request, name, path, caller) =>
      routes.get(name)?.(request, path, caller),
    publicRoute: async (request, name, path) =>
      publicRoutes.get(name)?.(request, path),
    logins: () =>
      logins.flatMap(({ plugin, offered }) =>
        offered().map((login) => ({
          ...login,
          path: `/api/plugins/${plugin}/${login.path}`,
        })),
      ),
  };
}

function pluginSessions(
  sessions: Sessions,
  plugin: string,
  loadOnly: (plugins: readonly string[]) => void,
): ServerPluginContext["sessions"] {
  const ownedHere = (id: string): string => {
    if (sessions.get(id)?.owner?.plugin !== plugin) {
      throw new Error(`session ${id} isn't owned by ${plugin}`);
    }

    return id;
  };

  const settle = (
    outcome:
      { readonly ok: true } | { readonly ok: false; readonly reason: string },
    done: string,
  ): void => {
    if (!outcome.ok) {
      throw new Error(`session not ${done}: ${outcome.reason}`);
    }
  };

  return {
    loadOnly,
    start: (request, ownerKey) => {
      const started = sessions.start(
        request,
        ownerKey === undefined ? undefined : { plugin, key: ownerKey },
      );

      if (!started.ok) {
        throw new Error(`session not started: ${started.reason}`);
      }

      return started.value;
    },
    get: (id) => sessions.get(id),
    owned: (key, { archived = false } = {}) =>
      sessions.list({ archived, owner: { plugin, key } }),
    adopt: (id, key) => {
      sessions.adopt(id, { plugin, key });
    },
    archive: (id) => {
      settle(sessions.archive(ownedHere(id)), "archived");
    },
    unarchive: (id) => {
      settle(sessions.unarchive(ownedHere(id)), "unarchived");
    },
    send: (id, text, actor, notice) =>
      sessions.send(
        id,
        notice
          ? {
              actor,
              type: "notice",
              text,
              notice: { plugin, ...notice },
              turn: true,
            }
          : { actor, type: "message", text, delivery: "followUp" },
      ),
    notify: (id, text, actor, notice) =>
      sessions.send(
        id,
        notice
          ? {
              actor,
              type: "notice",
              text,
              notice: { plugin, ...notice },
              turn: false,
            }
          : { actor, type: "context", text },
      ),
    transcript: (id) => sessions.transcript(id),
    transcriptLength: (id) => sessions.transcriptLength(id),
  };
}

const resultRetryMs = 1000;

// A result that finds the command stream reconnecting waits for the same
// attempt to come back. Like the projects outbox (ADR 0016), this holds only
// what the server sends, never user input (ADR 0006).
function sendResult(
  deps: {
    readonly sessions: Sessions;
    readonly runners: {
      readonly token: (environment: string, runner: string) => string;
      readonly revoke: (environment: string, runner: string) => void;
    };
    readonly signal: AbortSignal;
    readonly log: Log;
  },
  sessionId: string,
  call: ToolCall,
  command: Command,
): void {
  const fields = {
    sessionId,
    generation: call.generation,
    tool: call.name,
    callId: call.id,
  };

  const send = (): Result<undefined> =>
    deps.sessions.isCurrent(sessionId, call.generation)
      ? deps.sessions.send(sessionId, command)
      : { ok: false, reason: "stale_generation" };

  const sent = send();
  if (sent.ok) {
    return;
  }

  if (sent.reason !== "offline") {
    deps.log("tool result dropped", { ...fields, reason: sent.reason });

    return;
  }

  if (deps.signal.aborted) {
    return;
  }

  deps.log("tool result waiting for the session", fields);

  const stop = (): void => {
    clearInterval(retry);
    deps.signal.removeEventListener("abort", stop);
  };

  const retry = setInterval(() => {
    const resent = send();
    if (!resent.ok && resent.reason === "offline") {
      return;
    }

    stop();

    if (resent.ok) {
      deps.log("tool result delivered", fields);
    } else {
      deps.log("tool result dropped", { ...fields, reason: resent.reason });
    }
  }, resultRetryMs);

  deps.signal.addEventListener("abort", stop);
}

export interface InstalledPlugins {
  readonly plugins: readonly {
    readonly manifest: PluginManifest;
    readonly on: boolean;
    readonly web?: string;
    readonly session?: { readonly path: string; readonly hash: string };
    readonly error?: string;
    readonly source?: { readonly url: string; readonly pinned: string };
    readonly digest?: string;
  }[];
  readonly turnOn: (id: string, on: boolean) => Promise<void>;
  readonly install: (
    url: string,
    taken: (id: string) => boolean,
  ) => Promise<InstalledPlugins["plugins"][number]>;
  readonly update: (
    id: string,
  ) => Promise<InstalledPlugins["plugins"][number] | undefined>;
  readonly remove: (id: string) => Promise<void>;
  readonly reread: (id: string) => Promise<InstalledPlugins["plugins"][number]>;
  readonly files: (id: string) => Promise<readonly string[]>;
  readonly read: (id: string, path: string) => Promise<string>;
  readonly write: (id: string, path: string, content: string) => Promise<void>;
  readonly build: (id: string) => Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// An installed plugin reaches only the parts of its context it declared, so a
// mistake shows when it registers. It isn't a sandbox: the plugin runs in the
// server's process (ADR 0022).
function limited(
  plugin: string,
  declared: readonly Capability[],
  installed: boolean,
  context: ServerPluginContext,
): ServerPluginContext {
  return new Proxy(context, {
    get: (target, key, receiver) => {
      if (installed && key === "auth") {
        throw new Error(`${plugin} uses auth, which only built-in plugins get`);
      }

      const capability = capabilities.find((each) => each === key);

      if (capability !== undefined && !declared.includes(capability)) {
        throw new Error(
          `${plugin} uses ${capability} without declaring it in pipoca.capabilities`,
        );
      }

      return Reflect.get(target, key, receiver) as unknown;
    },
  });
}
