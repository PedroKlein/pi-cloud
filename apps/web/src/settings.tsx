import { Button, cn, fieldClass, PageTitle } from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api, send } from "./api";
import { useMcpTokens } from "./hooks";

export function SettingsPage(): ReactElement {
  const { value: tokens, reload } = useMcpTokens();

  // A token shows once, right after it is made, like an Environment's key.
  const [made, setMade] = useState<{
    readonly name: string;
    readonly secret: string;
  }>();

  const [error, setError] = useState<string>();

  const revoke = (id: string, name: string): void => {
    if (!confirm(`${name} won't be able to reach Pipoca any more.`)) {
      return;
    }

    send(`/api/mcp-tokens/${encodeURIComponent(id)}`, "DELETE").then(
      () => {
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
    <div
      id="settings-page"
      className="mx-auto flex w-full max-w-form flex-col px-4 py-10 md:px-10"
    >
      <PageTitle description="An MCP client, such as Pi or Claude Code on your laptop, can use the assistant's tools to manage Sessions, Environments, Profiles and Projects as you. It asks for a token, and you can revoke one at any time.">
        MCP clients
      </PageTitle>
      <div className="flex flex-col gap-3">
        <NewToken
          onCreated={(name, secret) => {
            setMade({ name, secret });
            reload();
          }}
        />
        {made && (
          <div className="flex flex-col gap-2 text-ui">
            <p className="text-fg-dim">
              Add the server to your client with this token. It is shown only
              now.
            </p>
            <pre
              aria-label="Add command"
              className="overflow-x-auto rounded-md border border-line bg-elevated p-3 font-mono text-mono-sm"
            >
              {`claude mcp add --transport http pipoca ${location.origin}/api/mcp --header "Authorization: Bearer ${made.secret}"`}
            </pre>
          </div>
        )}
        <ul
          aria-label="MCP tokens"
          className="flex flex-col gap-1 rounded-lg border border-line bg-elevated shadow-xs p-3 text-ui"
        >
          {tokens.length === 0 && (
            <li className="text-fg-dim">No client has a token.</li>
          )}
          {tokens.map((token) => (
            <li key={token.id} className="flex items-center gap-2">
              <span className="flex-1 truncate text-fg">{token.name}</span>
              <span className="text-caption text-fg-dim">
                {new Date(token.createdAt).toLocaleDateString()}
              </span>
              <Button
                aria-label={`Revoke ${token.name}`}
                onClick={() => {
                  revoke(token.id, token.name);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
        {error !== undefined && (
          <p role="alert" className="text-caption text-failed">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function NewToken({
  onCreated,
}: {
  readonly onCreated: (name: string, secret: string) => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = new FormData(form).get("name");

    void api("/api/mcp-tokens", { name })
      .then(async (response) => {
        const created = (await response.json()) as {
          readonly token: { readonly name: string };
          readonly secret: string;
        };

        setError(undefined);
        form.reset();
        onCreated(created.token.name, created.secret);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return (
    <form
      onSubmit={submit}
      aria-label="New MCP token"
      className="flex flex-wrap items-center gap-2"
    >
      <input
        name="name"
        required
        aria-label="Client name"
        placeholder="My laptop"
        className={cn(fieldClass, "w-48")}
      />
      <Button type="submit">New token</Button>
      {error !== undefined && (
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      )}
    </form>
  );
}
