import type { Toolset } from "@pi-cloud/plugins";
import {
  isolations,
  type PluginInfo,
  type Profile,
  type Session,
} from "@pi-cloud/protocol";

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

Its package.json has "type": "module", any npm "dependencies" its parts import, and a "piCloud" field:
- id (the folder's name), title, description, engine: 1;
- capabilities: the parts of the server context its server part uses, some of tools, toolsets, events, sessions, environments, profiles, routes, models;
- parts: server, web and session, each a TypeScript or JavaScript file, all optional;
- ownSessionsOnly: true to load its Session part only in the Sessions its server part owns;
- settings: optional, by name, each { type: "string" | "number" | "boolean" | "choice" | "strings", title, description?, default, options? for choice, min?/max? for number }.

The server part's default export is { name: <id>, register(context) }. context.routes.handle(async (request, path) => Response) answers /api/plugins/<id>/<path>, so it needs no web framework such as Express; context.settings.get() returns its settings; context.tools, context.toolsets and context.events register tools, meta toolsets and event listeners.
The web part's default export is a WebPlugin { name: <id>, nav?: { label, Page } , SessionPanel?, SessionHeader?, tools?, widgets? }. It imports react, react-dom, @pi-cloud/ui and @pi-cloud/plugins/web from the page, can't import CSS or other files, and styles itself with @pi-cloud/ui components.
The Session part's default export is a SessionPlugin { name: <id>, extension?: (cloud) => Pi extension factory, packages?: Pi packages, tools?: (cloud) => Pi tool definitions }. It can't import files other than code.`;

// The kernel's meta toolsets (ADR 0035). Each tool is a request to the route
// the web UI uses for the same change.
export const kernelToolsets: readonly Toolset[] = [
  {
    namespace: {
      name: "sessions",
      description: "List, start, open and archive Pi Cloud Sessions.",
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

function titleOf({ title }: Session): string {
  return title === null || title === "" ? "the Session" : `“${title}”`;
}
