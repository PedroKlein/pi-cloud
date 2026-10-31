import {
  fieldsOf,
  isObject,
  type RouteTool,
  type Toolset,
} from "@pipoca/plugins";
import {
  isolations,
  type PluginInfo,
  type Profile,
  type Session,
  type ToolNamespace,
  type ToolResult,
  type ToolSpec,
  type UiAction,
} from "@pipoca/protocol";
import type { OnBehalf } from "./host";

const workspaceSchema = {
  type: "object",
  description:
    "A folder or worktree on a runner's machine (path), a clone of one repository, or several repositories side by side",
  properties: {
    kind: {
      type: "string",
      enum: ["folder", "worktree", "clone", "repositories"],
    },
    path: { type: "string" },
    repository: { type: "string" },
    repositories: {
      type: "array",
      items: {
        type: "object",
        properties: { repository: { type: "string" } },
        required: ["repository"],
      },
    },
  },
  required: ["kind"],
};

const profileFields = {
  packages: {
    type: "array",
    description: "Pi packages, such as npm:pi-subagents",
    items: {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: {
            source: { type: "string" },
            autoload: { type: "boolean" },
            extensions: { type: "array", items: { type: "string" } },
            skills: { type: "array", items: { type: "string" } },
            prompts: { type: "array", items: { type: "string" } },
            themes: { type: "array", items: { type: "string" } },
          },
          required: ["source"],
        },
      ],
    },
  },
  agentsMd: { type: "string", description: "AGENTS.md" },
  systemMd: { type: "string", description: "SYSTEM.md, replacing Pi's" },
  appendSystemMd: { type: "string", description: "APPEND_SYSTEM.md" },
  settings: { type: "object", description: "Pi settings" },
};

const pluginInstructions = `An in-place plugin is a folder in the server's plugins folder, named by its id (lowercase letters, digits and dashes). Write its files with plugins_write_file, then plugins_build to check it builds. You never turn a plugin on: tell the user to turn it on on the Plugins page and restart the server, since its code then runs in the server and on runners. A plugin that is turned on can't be changed until the user turns it off. After writing, always build, then tell the user in a sentence what you wrote, whether it builds, and that they turn it on on the Plugins page; if a tool refuses, say why.

Its package.json has "type": "module", any npm "dependencies" its parts import, and a "pipoca" field:
- id (the folder's name), title, description, engine: 1, and an optional version;
- capabilities: the parts of the server context its server part uses, some of tools, toolsets, events, sessions, environments, profiles, routes, models;
- parts: server, web and session, each a TypeScript or JavaScript file, all optional;
- ownSessionsOnly: true to load its Session part only in the Sessions its server part owns;
- settings: optional, by name, each { type: "string" | "number" | "boolean" | "choice" | "strings", title, description?, default, options? for choice, min?/max? for number }.

Type each part with types from @pipoca/plugins (ServerPlugin, SessionPlugin) or @pipoca/plugins/web (WebPlugin) and check its default export with satisfies. The server and Session parts import @pipoca/plugins from the running server, so it needs no dependency: HttpError(status, message, code?), BadRequest and NotFound, thrown from a route, answer with that status and { error: code, message }, where code is a snake_case string that defaults to one for the status, such as bad_request or not_found; requireAdmin(caller, message) throws a 403 unless the caller is an admin; readJson(request) reads a JSON body or throws a 400; fieldsOf(body) gives a body's fields to check.

The server part's default export is a ServerPlugin { name: <id>, register(context) }. Reaching a context member whose capability isn't declared fails the plugin when it registers.
- context.routes.handle((request, path, caller) => Response | Promise<Response>) answers /api/plugins/<id>/<path>, so it needs no web framework such as Express. caller is { kind: "user", actor, admin } for a signed-in user, also through a toolset tool (admin is false from a meta-session), or { kind: "session", session, actor } when its Session part sent the request. A route acts as its caller: a Session it starts for a user takes actor: caller.actor. A route that changes config every user shares calls requireAdmin(caller, message) first. The method says what a route does: GET reads, POST adds or changes, DELETE removes, so DELETE items/<id> rather than POST items/<id>/remove.
- context.store is its SQLite database: exec(sql), all(sql, ...params), run(sql, ...params), and seal(text, context)/open(sealed, context) for secrets. Name its tables <id>_<table>.
- context.settings.get() returns its settings. context.config.get() and set(value) read and replace its key in the server's pipoca.json, and context.config.dir is a folder of its own.
- context.changes.publish(name) tells open pages that something changed; they hear the topic "<id>.<name>".
- context.tools, toolsets, events, sessions, environments, profiles and models each need their capability: they register tools, meta toolsets and event listeners, start and message Sessions, give runners tokens, provide Profiles, and offer models.
- context.owner, context.signal (aborted when the server stops) and context.log(message, fields?) need no capability.
The web part's default export is a WebPlugin { name: <id>, nav?: { label, Page, Items?, fills? }, Home?, sessionPath?, SessionPanel?, SessionHeader?, EnvironmentSection?, TemplateSection?, SettingsSection?, tools?, widgets?, notices?, links?, repositories? }. Page gets { context, path }: context.request(path, init?) is fetch for its own routes, or for the server's API when path starts with /, and context.settings holds its settings. useLoaded(load, key, { topics, everyMs }) from @pipoca/plugins/web loads data and loads it again when a topic such as "<id>.<name>" changes. It imports react, react-dom, @pipoca/ui and @pipoca/plugins/web from the page, can't import CSS or other files, and styles itself with @pipoca/ui components.
The Session part's default export is a SessionPlugin { name: <id>, extension?: (cloud) => Pi extension factory, packages?: Pi packages, tools?: (cloud) => Pi tool definitions, logins?: async (cloud) => { models: Pi CredentialStore, mcp: McpLoginStore } for the Session's logins }. cloud.request(path, init?) calls its own routes as the Session, cloud.settings holds its settings when the Session started, cloud.publish(key, data) shares a value with everyone watching the Session, and cloud.log(message, fields?) logs. It can't import files other than code.`;

// The kernel's meta toolsets (ADR 0035). Each tool is a request to the route
// the web UI uses for the same change.
export const kernelToolsets: readonly Toolset[] = [
  {
    namespace: {
      name: "sessions",
      description: "List, start, open and archive Pipoca Sessions.",
    },
    tools: [
      {
        name: "list",
        description:
          "List the user's Sessions, newest first, with their status. Archived ones only when archived is true.",
        parameters: object({ archived: { type: "boolean" } }),
        exposure: "direct",
        annotations: { readOnlyHint: true },
        request: (input) => ({
          method: "GET",
          path:
            input["archived"] === true
              ? "/api/sessions?archived=true"
              : "/api/sessions",
        }),
        result: (body) => (body as readonly Session[]).map(summary),
      },
      {
        name: "get",
        description: "Get one Session by id.",
        parameters: object({ id: { type: "string" } }, ["id"]),
        annotations: { readOnlyHint: true },
        request: (input) => ({
          method: "GET",
          path: `/api/sessions/${idOf(input)}`,
        }),
      },
      {
        name: "start",
        description:
          "Start a Session. Without an environment or profile it uses the defaults. firstMessage is what the Session's agent is asked to do first.",
        parameters: object(
          {
            environment: { type: "string", description: "Environment id" },
            profile: { type: "string", description: "Profile id" },
            workspace: workspaceSchema,
            model: {
              type: "object",
              properties: {
                provider: { type: "string" },
                id: { type: "string" },
              },
              required: ["provider", "id"],
            },
            firstMessage: { type: "string" },
          },
          ["workspace"],
        ),
        exposure: "direct",
        // The new Session's agent runs whatever firstMessage says without a
        // confirm of its own, so starting one is open-world.
        annotations: { destructiveHint: false, openWorldHint: true },
        request: (input) => ({
          method: "POST",
          path: "/api/sessions",
          body: picked(input, [
            "environment",
            "profile",
            "workspace",
            "model",
            "firstMessage",
          ]),
        }),
        result: (body) => summary(body as Session),
        opens: (body) => ({
          route: (body as Session).id,
          label: "the new Session",
        }),
      },
      {
        name: "open",
        description: "Open a Session for the user to watch or take over.",
        parameters: object({ id: { type: "string" } }, ["id"]),
        exposure: "direct",
        annotations: { readOnlyHint: true },
        request: (input) => ({
          method: "GET",
          path: `/api/sessions/${idOf(input)}`,
        }),
        result: () =>
          "Offered it to the user in the browsers that show this chat.",
        opens: (body) => ({
          route: (body as Session).id,
          label: titleOf(body as Session),
        }),
      },
      {
        name: "archive",
        description:
          "Archive a Session. Its workspace is removed when nothing would lose work.",
        parameters: object({ id: { type: "string" } }, ["id"]),
        annotations: { destructiveHint: true },
        asks: {
          lookup: (input) => `/api/sessions/${idOf(input)}`,
          text: (_input, found) =>
            `Archive ${found === undefined ? "this Session" : titleOf(found as Session)}?`,
        },
        request: (input) => ({
          method: "POST",
          path: `/api/sessions/${idOf(input)}/archive`,
        }),
      },
    ],
  },
  {
    namespace: {
      name: "environments",
      description:
        "List, create and change Environments, where Sessions run (ADR 0032).",
      instructions:
        "Secret values can't be set here, since tool calls are kept in the transcript: ask the user to add secrets on the Environments page.",
    },
    tools: [
      {
        name: "list",
        description:
          "List Environments with their runners, isolation, image, setup script, variables and secret names.",
        parameters: object({}),
        annotations: { readOnlyHint: true },
        request: () => ({ method: "GET", path: "/api/environments" }),
      },
      {
        name: "create",
        description: "Create an Environment with a name.",
        parameters: object({ name: { type: "string" } }, ["name"]),
        annotations: { destructiveHint: false, openWorldHint: false },
        request: (input) => ({
          method: "POST",
          path: "/api/environments",
          body: picked(input, ["name"]),
        }),
        result: (body) => ({
          environment: (body as { environment: unknown }).environment,
          note: "Its runner key isn't shown here. The user gets one with Replace key on the Environments page.",
        }),
      },
      {
        name: "update",
        description:
          "Change an Environment. Only the fields given change; variables replaces all of its variables.",
        parameters: object(
          {
            id: { type: "string" },
            name: { type: "string" },
            isolation: { type: "string", enum: isolations },
            image: {
              type: ["string", "null"],
              description: "Container image, or null for the default one",
            },
            setupScript: { type: "string" },
            variables: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          ["id"],
        ),
        annotations: { destructiveHint: true },
        asks: {
          lookup: () => "/api/environments",
          text: (input, found) =>
            `Change ${named(found, input, "the Environment", "this Environment")}?`,
        },
        request: (input) => ({
          method: "PATCH",
          path: `/api/environments/${idOf(input)}`,
          body: picked(input, [
            "name",
            "isolation",
            "image",
            "setupScript",
            "variables",
          ]),
        }),
      },
    ],
  },
  {
    namespace: {
      name: "profiles",
      description:
        "List, create and change Profiles: the Pi packages, instructions and settings a Session starts with (ADR 0031).",
    },
    tools: [
      {
        name: "list",
        description: "List the user's Profiles.",
        parameters: object({}),
        annotations: { readOnlyHint: true },
        request: () => ({ method: "GET", path: "/api/profiles" }),
        result: (body) => (body as readonly Profile[]).map(profileView),
      },
      {
        name: "get",
        description: "Get one Profile by id.",
        parameters: object({ id: { type: "string" } }, ["id"]),
        annotations: { readOnlyHint: true },
        request: (input) => ({
          method: "GET",
          path: `/api/profiles/${idOf(input)}`,
        }),
        result: (body) => profileView(body as Profile),
      },
      {
        name: "create",
        description: "Create a Profile.",
        parameters: object({ name: { type: "string" }, ...profileFields }, [
          "name",
        ]),
        // Its packages are installed and run in every Session that uses it.
        annotations: { destructiveHint: false, openWorldHint: true },
        request: (input) => ({
          method: "POST",
          path: "/api/profiles",
          body: picked(input, ["name", ...Object.keys(profileFields)]),
        }),
        result: (body) => profileView(body as Profile),
      },
      {
        name: "update",
        description:
          "Change a Profile. Only the fields given change. Sessions pick it up the next time their Pi starts.",
        parameters: object(
          {
            id: { type: "string" },
            name: { type: "string" },
            ...profileFields,
          },
          ["id"],
        ),
        annotations: { destructiveHint: true },
        asks: {
          lookup: (input) => `/api/profiles/${idOf(input)}`,
          text: (input, found) =>
            `Change ${named(found, input, "the Profile", "this Profile")}?`,
        },
        request: (input) => ({
          method: "PUT",
          path: `/api/profiles/${idOf(input)}`,
          body: picked(input, ["name", ...Object.keys(profileFields)]),
        }),
        result: (body) => profileView(body as Profile),
      },
      {
        name: "make_default",
        description: "Make a Profile the one new Sessions use by default.",
        parameters: object({ id: { type: "string" } }, ["id"]),
        annotations: { destructiveHint: true },
        asks: {
          lookup: (input) => `/api/profiles/${idOf(input)}`,
          text: (input, found) =>
            `Make ${named(found, input, "the Profile", "this Profile")} the default for new Sessions?`,
        },
        request: (input) => ({
          method: "POST",
          path: `/api/profiles/${idOf(input)}/default`,
        }),
      },
    ],
  },
  {
    namespace: {
      name: "plugins",
      description:
        "List plugins, and write and build in-place plugins, which the user then turns on (ADR 0035).",
      instructions: pluginInstructions,
    },
    tools: [
      {
        name: "list",
        description:
          "List the plugins with their state, whether they are turned on, and where installed ones came from.",
        parameters: object({}),
        annotations: { readOnlyHint: true },
        request: () => ({ method: "GET", path: "/api/plugins" }),
        result: (body) => (body as readonly PluginInfo[]).map(pluginSummary),
      },
      {
        name: "files",
        description: "List the files of an installed plugin.",
        parameters: object({ plugin: { type: "string" } }, ["plugin"]),
        annotations: { readOnlyHint: true },
        request: (input) => ({
          method: "GET",
          path: `/api/plugin-files/${pluginOf(input)}`,
        }),
      },
      {
        name: "read_file",
        description: "Read a file of an installed plugin.",
        parameters: object(
          { plugin: { type: "string" }, path: { type: "string" } },
          ["plugin", "path"],
        ),
        annotations: { readOnlyHint: true },
        request: (input) => ({
          method: "GET",
          path: `/api/plugin-files/${pluginOf(input)}?path=${encodeURIComponent(textIn(input, "path"))}`,
        }),
      },
      {
        name: "write_file",
        description:
          "Write a file of an in-place plugin, making the plugin when it doesn't exist yet. Nothing in it runs until the user turns it on.",
        parameters: object(
          {
            plugin: { type: "string", description: "The plugin's id" },
            path: {
              type: "string",
              description: "Relative to the plugin's folder, such as server.ts",
            },
            content: { type: "string" },
          },
          ["plugin", "path", "content"],
        ),
        annotations: { destructiveHint: false, openWorldHint: false },
        request: (input) => ({
          method: "PUT",
          path: `/api/plugin-files/${pluginOf(input)}`,
          body: picked(input, ["path", "content"]),
        }),
        result: (body) => pluginSummary(body as PluginInfo),
      },
      {
        name: "build",
        description:
          "Install an in-place plugin's dependencies and bundle its parts, to see whether it builds. None of its code runs.",
        parameters: object({ plugin: { type: "string" } }, ["plugin"]),
        annotations: { destructiveHint: false, openWorldHint: true },
        request: (input) => ({
          method: "POST",
          path: `/api/plugin-builds/${pluginOf(input)}`,
        }),
        result: (body) => ({
          ...pluginSummary(body as PluginInfo),
          note: "It builds. The user turns it on on the Plugins page, then restarts the server.",
        }),
        opens: () => ({ route: "plugins", label: "the Plugins page" }),
      },
    ],
  },
];

function object(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function pluginOf(input: Readonly<Record<string, unknown>>): string {
  return encodeURIComponent(textIn(input, "plugin"));
}

function textIn(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key];

  return typeof value === "string" ? value : "";
}

function pluginSummary(plugin: PluginInfo): Record<string, unknown> {
  return {
    id: plugin.id,
    title: plugin.title,
    source: plugin.source,
    state: plugin.state,
    turnedOn: plugin.turnedOn,
    ...(plugin.error !== undefined && { error: plugin.error }),
    ...(plugin.installedFrom !== undefined && {
      installedFrom: plugin.installedFrom.url,
    }),
  };
}

function idOf(input: Readonly<Record<string, unknown>>): string {
  return encodeURIComponent(typeof input["id"] === "string" ? input["id"] : "");
}

function picked(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );
}

function summary(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    waiting: session.waiting,
    environmentId: session.environmentId,
    profileId: session.profileId,
    workspace: session.workspace.kind,
    model: session.model,
    createdAt: session.createdAt,
  };
}

// MCP server entries usually hold tokens in their env and headers, so the
// model sees only their names.
function profileView(profile: Profile): Record<string, unknown> {
  const { mcpServers, ...rest } = profile;

  return { ...rest, mcpServers: Object.keys(mcpServers) };
}

// The thing a call changes by its name, found by id in a list or as the
// reply itself: the Environment “Dev”.
function named(
  found: unknown,
  input: Readonly<Record<string, unknown>>,
  kind: string,
  unnamed: string,
): string {
  const one = Array.isArray(found)
    ? (found as unknown[]).find(
        (each) => isObject(each) && each["id"] === input["id"],
      )
    : found;

  const name = isObject(one) ? one["name"] : undefined;

  return typeof name === "string" && name !== ""
    ? `${kind} “${name}”`
    : unnamed;
}

function titleOf({ title }: Session): string {
  return title === null || title === "" ? "the Session" : `“${title}”`;
}

export interface ToolsetTool {
  // Undefined for the kernel's own toolsets.
  readonly plugin: string | undefined;
  readonly spec: ToolSpec;
  readonly tool: RouteTool;
}

export function toolsetTools(toolset: Toolset, plugin?: string): ToolsetTool[] {
  const namespace: ToolNamespace = toolset.namespace;

  return toolset.tools.map((tool) => {
    const {
      request: _request,
      result: _result,
      opens: _opens,
      asks: _asks,
      ...spec
    } = tool;

    return {
      plugin,
      tool,
      spec: {
        ...spec,
        name: `${namespace.name}_${tool.name}`,
        exposure: tool.exposure ?? "deferred",
        namespace,
      },
    };
  });
}

// A route of the web app such as a Session id or <project id>/<thread id>,
// so what a tool opens stays a page of Pipoca.
const appRoute = /^[\w-]+(\/[\w-]+)*$/;

// Never sent anywhere: the request goes straight to the server's handler.
const internalOrigin = "http://pipoca.internal";

export async function runRouteTool(
  found: ToolsetTool,
  input: unknown,
  onBehalf: OnBehalf,
  deps: {
    readonly api: (onBehalf: OnBehalf, request: Request) => Promise<Response>;
  },
  open: (action: UiAction) => void,
): Promise<ToolResult> {
  const { method, path, body } = found.tool.request(fieldsOf(input));
  const base = baseOf(found);

  const url = routeUrl(found.plugin === undefined ? path : base + path, base);

  if (url === undefined) {
    return { text: `${path} isn't one of its routes`, isError: true };
  }

  const response = await deps.api(
    onBehalf,
    new Request(
      url,
      body === undefined
        ? { method }
        : {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    ),
  );

  const text = await response.text();

  if (!response.ok) {
    return {
      text: text || `failed with ${String(response.status)}`,
      isError: true,
    };
  }

  if (text === "") {
    return { text: "Done.", isError: false };
  }

  // The change is made by now, so a reply the tool can't read is still a
  // success; an error would make the model try again.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, isError: false };
  }

  try {
    const opened = found.tool.opens?.(parsed);

    if (opened !== undefined && appRoute.test(opened.route)) {
      open({
        kind: "open",
        route:
          found.plugin === undefined
            ? opened.route
            : `plugin/${found.plugin}/${opened.route}`,
        label: opened.label,
      });
    }

    return {
      text: JSON.stringify(
        found.tool.result ? found.tool.result(parsed) : parsed,
      ),
      isError: false,
    };
  } catch {
    return { text: "Done, with a reply it couldn't show.", isError: false };
  }
}

export async function routeToolQuestion(
  found: ToolsetTool,
  input: unknown,
  onBehalf: OnBehalf,
  deps: {
    readonly api: (onBehalf: OnBehalf, request: Request) => Promise<Response>;
  },
): Promise<string | undefined> {
  const asks = found.tool.asks;

  if (asks === undefined) {
    return undefined;
  }

  const fields = fieldsOf(input);
  const path = asks.lookup?.(fields);
  const base = baseOf(found);

  const url =
    path === undefined
      ? undefined
      : routeUrl(found.plugin === undefined ? path : base + path, base);

  let looked: unknown;
  if (url !== undefined) {
    try {
      const response = await deps.api(onBehalf, new Request(url));
      looked = response.ok ? await response.json() : undefined;
    } catch {
      looked = undefined;
    }
  }

  return asks.text(fields, looked);
}

function baseOf(found: ToolsetTool): string {
  return found.plugin === undefined ? "/api/" : `/api/plugins/${found.plugin}/`;
}

// A tool's path stays under its own routes: dot segments, plain or
// percent-encoded, would let input such as an id name another route.
function routeUrl(path: string, base: string): string | undefined {
  const [pathname = ""] = path.split("?");

  const dotted = pathname.split("/").some((segment) => {
    try {
      return [".", ".."].includes(decodeURIComponent(segment));
    } catch {
      return true;
    }
  });

  const url = new URL(path, internalOrigin);

  return dotted || !url.pathname.startsWith(base) ? undefined : url.href;
}
