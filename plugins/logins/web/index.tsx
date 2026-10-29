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
        {value.mcp.length === 0 && (
          <li className="text-fg-dim">
            You haven't signed in to any MCP server yet.
          </li>
        )}
        {value.mcp.map(({ server }) => {
          const [name = server, address = ""] = server.split(" ");

          return (
            <li key={server} className="flex items-center gap-2">
              <span className="flex-1 truncate text-fg">
                {name}
                <span className="text-fg-dim">{` · ${address}`}</span>
              </span>
              <Button
                aria-label={`Log out of ${name}`}
                onClick={() => {
                  void json(
                    context.request(`mcp/${encodeURIComponent(server)}`, {
                      method: "DELETE",
                    }),
                  ).then(reload, reload);
                }}
              >
                Log out
              </Button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
