import {
  json,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pipoca/plugins/web";
import { Button, Section } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import type { Account } from "../src/model";
import { ConnectForm, ConnectionCard } from "./connect";

export const logins: WebPlugin = {
  name: "logins",
  SettingsSection,
};

const typeLabels = { oauth: "account", api_key: "API key" } as const;

function SettingsSection({
  context,
}: {
  readonly context: WebContext;
}): ReactElement | null {
  const { value, reload } = useLoaded(
    async () => json<Account>(context.request("account")),
    "account",
    { topics: ["logins.logins"] },
  );

  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string>();

  if (value === undefined) {
    return null;
  }

  // The servers of the person's Profiles, and any other they signed in to
  // from a Session.
  const stored = new Set(value.mcp.map(({ server }) => server));

  const mcpServers = [
    ...new Set([...value.servers.map(({ key }) => key), ...stored]),
  ]
    .sort()
    .map((key) => ({ key, signedIn: stored.has(key) }));

  const send = (path: string, init: RequestInit): void => {
    json(context.request(path, init)).then(
      () => {
        setChoosing(false);
        setError(undefined);
        reload();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        reload();
      },
    );
  };

  return (
    <Section title="Logins">
      <p className="text-ui text-fg-dim">
        Your Sessions use these logins on every runner. Connect a model provider
        here or with /login in any Session, and an MCP server with /mcp login.
      </p>
      {value.connection !== undefined && (
        <ConnectionCard connection={value.connection} send={send} />
      )}
      {value.connection === undefined && choosing && (
        <ConnectForm
          context={context}
          send={send}
          onClose={() => {
            setChoosing(false);
          }}
        />
      )}
      {value.connection === undefined && !choosing && (
        <div>
          <Button
            variant="primary"
            onClick={() => {
              setChoosing(true);
            }}
          >
            Connect a provider
          </Button>
        </div>
      )}
      {error !== undefined && (
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      )}
      <ul
        aria-label="Your model logins"
        className="flex flex-col gap-2 rounded-lg border border-line bg-elevated shadow-xs p-3 text-ui"
      >
        {value.logins.length === 0 && (
          <li className="text-fg-dim">
            You haven't logged in to any model provider yet.
          </li>
        )}
        {value.logins.map((login) => (
          <li key={login.provider} className="flex items-center gap-2">
            <span className="flex-1 truncate text-fg">
              {login.provider}
              <span className="text-fg-dim">
                {` · ${typeLabels[login.type]}`}
              </span>
            </span>
            <Button
              aria-label={`Log out of ${login.provider}`}
              onClick={() => {
                void json(
                  context.request(
                    `credentials/${encodeURIComponent(login.provider)}`,
                    { method: "DELETE" },
                  ),
                ).then(reload, reload);
              }}
            >
              Log out
            </Button>
          </li>
        ))}
      </ul>
      <ul
        aria-label="Your MCP logins"
        className="flex flex-col gap-2 rounded-lg border border-line bg-elevated shadow-xs p-3 text-ui"
      >
        {mcpServers.length === 0 && (
          <li className="text-fg-dim">
            None of your Profiles has an MCP server that signs in.
          </li>
        )}
        {mcpServers.map(({ key, signedIn }) => {
          const [name = key, address = ""] = key.split(" ");

          return (
            <li key={key} className="flex items-center gap-2">
              <span className="flex-1 truncate text-fg">
                {name}
                <span className="text-fg-dim">
                  {` · ${address}${signedIn ? "" : " · not signed in"}`}
                </span>
              </span>
              {signedIn ? (
                <Button
                  aria-label={`Log out of ${name}`}
                  onClick={() => {
                    send(`mcp/${encodeURIComponent(key)}`, {
                      method: "DELETE",
                    });
                  }}
                >
                  Log out
                </Button>
              ) : (
                <Button
                  aria-label={`Sign in to ${name}`}
                  disabled={value.connection?.state === "running"}
                  onClick={() => {
                    send("connect-mcp", {
                      method: "POST",
                      body: JSON.stringify({ server: key }),
                    });
                  }}
                >
                  Sign in
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
