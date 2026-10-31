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

export interface Account {
  readonly host: string;
  readonly label: string;
  readonly login: string;
}

interface Sources {
  readonly accounts: (userId: string) => readonly Account[];
  readonly search: (
    userId: string,
    query: string,
    only?: string,
  ) => Promise<readonly HostSearch[]>;
}

// Each line goes into the model's context, so a search names a few.
const shown = 10;

// Lets an agent find the person's real repositories instead of guessing
// their URLs, on every host they connected.
export function repositoriesTool({ accounts, search }: Sources): ServerTool {
  return {
    name: "git_hosts_repositories",
    description: `Search the user's git hosts (such as github.com or a GitHub Enterprise host) for repositories by name, and get their clone URLs. Without a query it only names the connected hosts and the account on each. Returns at most ${String(shown)} repositories. Where the Session has a shell, git and gh are already signed in to the same accounts; use gh --hostname <host> for an enterprise host.`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Part of the repository's name, such as dotfiles",
        },
        host: {
          type: "string",
          description: "Search only this host, such as github.com",
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
      const userId = session.startedBy ?? "";

      const { query, host } = (input ?? {}) as {
        query?: unknown;
        host?: unknown;
      };

      const text = typeof query === "string" ? query.trim() : "";
      const only = typeof host === "string" ? host.trim().toLowerCase() : "";

      const signed = accounts(userId).filter(
        (account) => only === "" || account.host === only,
      );

      if (signed.length === 0) {
        return { text: unconnected(only), isError: false };
      }

      const heading = `Signed in on ${signed
        .map(({ host: name, label, login }) => `${name} (${label}) as ${login}`)
        .join(", ")}.`;

      if (text === "") {
        return {
          text: `${heading}\n\nGive a query to search their repositories by name.`,
          isError: false,
        };
      }

      const found = await search(userId, text, only || undefined);

      return {
        text: [heading, ...failures(found), listing(found, text)].join("\n\n"),
        isError: false,
      };
    },
  };
}

function unconnected(host: string): string {
  return host === ""
    ? "The user hasn't connected a git host. They can connect one in Pipoca's Settings, under Git hosts."
    : `The user hasn't connected ${host}. They can connect it in Pipoca's Settings, under Git hosts.`;
}

function failures(found: readonly HostSearch[]): readonly string[] {
  return found.flatMap(({ host, failure }) =>
    failure === undefined ? [] : [`Couldn't search ${host.host}: ${failure}`],
  );
}

function listing(found: readonly HostSearch[], query: string): string {
  const repositories = found.flatMap(({ host, repositories: listed }) =>
    listed.map(({ name, url }) => `- ${host.host} ${name} ${url}`),
  );

  if (repositories.length === 0) {
    return `No repository's name holds "${query}".`;
  }

  const more = repositories.length - shown;

  return [
    `Repositories whose name holds "${query}":`,
    ...repositories.slice(0, shown),
    ...(more > 0
      ? [`and ${String(more)} more; give a longer query to narrow it.`]
      : []),
  ].join("\n");
}
