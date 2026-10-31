import type { Toolset } from "@pipoca/plugins";
import type { ProjectView } from "./model";

const settingsFields = {
  name: { type: "string" },
  goal: {
    type: "string",
    description:
      "The outcome the Project works toward, given to its coordinator",
  },
  instructions: {
    type: "string",
    description: "What the coordinator should know about the Project's goal",
  },
  threadModel: {
    type: "string",
    description: "provider/id of the model thread Sessions use",
  },
  profile: {
    type: ["string", "null"],
    description: "Profile id, or null for the default Profile",
  },
};

// The Projects meta toolset (ADR 0035), through the routes the Projects page
// uses.
export const projectsToolset: Toolset = {
  namespace: {
    name: "projects",
    description:
      "List, create and change Projects: work on one goal across repositories, led by a coordinator Session (ADR 0016).",
  },
  tools: [
    {
      name: "list",
      description:
        "List Projects with their coordinator, thread counts and how many threads need the user.",
      parameters: object({}),
      exposure: "direct",
      annotations: { readOnlyHint: true },
      request: () => ({ method: "GET", path: "projects" }),
    },
    {
      name: "get",
      description: "Get one Project with its threads.",
      parameters: object({ id: { type: "string" } }, ["id"]),
      annotations: { readOnlyHint: true },
      request: (input) => ({ method: "GET", path: `projects/${idOf(input)}` }),
    },
    {
      name: "create",
      description:
        "Create a Project, which starts its coordinator Session with every repository checked out.",
      parameters: object(
        {
          ...settingsFields,
          repositories: {
            type: "array",
            description:
              "Clone URLs of git repositories, such as https://github.com/owner/name.git, each with a different name. A folder that isn't a git repository can't be one.",
            items: { type: "string" },
          },
          environment: { type: "string", description: "Environment id" },
          model: {
            type: "string",
            description: "provider/id of the coordinator's model",
          },
        },
        ["name", "repositories"],
      ),
      exposure: "direct",
      // It clones the repositories and starts a coordinator, whose agent
      // runs without a confirm of its own.
      annotations: { destructiveHint: false, openWorldHint: true },
      request: (input) => ({ method: "POST", path: "projects", body: input }),
      opens: (body) => ({
        route: (body as ProjectView).id,
        label: `“${(body as ProjectView).name}”`,
      }),
    },
    {
      name: "update",
      description: "Change a Project's settings. Only the fields given change.",
      parameters: object({ id: { type: "string" }, ...settingsFields }, ["id"]),
      annotations: { destructiveHint: true },
      asks: {
        lookup: (input) => `projects/${idOf(input)}`,
        text: (_input, found) =>
          found === undefined
            ? "Change this Project's settings?"
            : `Change the settings of “${(found as ProjectView).name}”?`,
      },
      request: (input) => ({
        method: "POST",
        path: `projects/${idOf(input)}/settings`,
        body: withoutId(input),
      }),
    },
  ],
};

function object(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  return { type: "object", properties, required, additionalProperties: false };
}

function idOf(input: Readonly<Record<string, unknown>>): string {
  return encodeURIComponent(typeof input["id"] === "string" ? input["id"] : "");
}

function withoutId(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const { id: _id, ...rest } = input;

  return rest;
}
