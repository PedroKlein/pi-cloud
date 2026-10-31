import type { ServerTool } from "@pipoca/plugins";
import type { Repository } from "./github";
import type { HostConfig } from "./hosts";

// What one of the person's connected hosts answered to a search.
export interface HostSearch {
  readonly host: HostConfig;
  readonly login: string;
  readonly repositories: readonly Repository[];
  readonly failure?: string;
}

const shown = 50;

// Lets an agent find the person's real repositories instead of guessing
// their URLs, on every host they connected.
export function repositoriesTool(
  search: (userId: string, query: string) => Promise<readonly HostSearch[]>,
): ServerTool {
  return {
    name: "git_hosts_repositories",
    description:
      "List the git hosts the user connected to Pipoca (such as github.com or a GitHub Enterprise host), the account on each, and their repositories with clone URLs: the ones they pushed to last, or those whose name holds the query. Where the Session has a shell, git and gh are already signed in to the same accounts; use gh --hostname <host> for an enterprise host.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Part of the repository's name, such as dotfiles. Leave it empty to list the ones pushed to last.",
        },
      },
      additionalProperties: false,
    },
    namespace: {
      name: "git_hosts",
      instructions:
        "Never guess a repository's URL or owner. Find it with git_hosts_repositories, or ask the user when it isn't there.",
    },
    exposure: "direct",
    annotations: { readOnlyHint: true, openWorldHint: true },
    appliesTo: ({ startedBy }) => startedBy !== null,
    run: async (input, { session }) => {
      const { query } = (input ?? {}) as { query?: unknown };
      const text = typeof query === "string" ? query.trim() : "";

      return {
        text: described(await search(session.startedBy ?? "", text), text),
        isError: false,
      };
    },
  };
}

function described(found: readonly HostSearch[], query: string): string {
  if (found.length === 0) {
    return "The user hasn't connected a git host. They can connect one in Pipoca's Settings, under Git hosts.";
  }

  const accounts = found
    .map(({ host, login }) => `${host.host} (${host.label}) as ${login}`)
    .join(", ");

  const failures = found.flatMap(({ host, failure }) =>
    failure === undefined ? [] : [`Couldn't search ${host.host}: ${failure}`],
  );

  const repositories = found.flatMap(({ host, repositories: listed }) =>
    listed.map(({ name, url }) => `- ${host.host} ${name} ${url}`),
  );

  return [
    `Signed in on ${accounts}.`,
    ...failures,
    listing(repositories, query),
  ].join("\n\n");
}

function listing(repositories: readonly string[], query: string): string {
  if (repositories.length === 0) {
    return query === ""
      ? "No repositories."
      : `No repository's name holds "${query}".`;
  }

  const more = repositories.length - shown;

  return [
    query === ""
      ? "Repositories pushed to last:"
      : `Repositories whose name holds "${query}":`,
    ...repositories.slice(0, shown),
    ...(more > 0
      ? [`and ${String(more)} more; give a query to narrow it.`]
      : []),
  ].join("\n");
}
