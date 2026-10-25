import { Button, cn, fieldClass, PageTitle, Section } from "@pi-cloud/ui";
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

  const revoke = (id: string): void => {
    void send(`/api/mcp-tokens/${encodeURIComponent(id)}`, "DELETE").then(
      reload,
      reload,
    );
  };

  return (
    <div
      id="settings-page"
      className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 md:px-10"
    >
      <PageTitle description="Your settings on this Pi Cloud server.">
        Settings
      </PageTitle>
      <Section title="MCP clients">
        <p className="text-ui text-fg-dim">
          An MCP client, such as Pi or Claude Code on your laptop, can use the
          assistant's tools to manage Sessions, Environments, Profiles and
          Projects as you. It asks for a token, and you can revoke one at any
          time.
        </p>
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
              {`claude mcp add --transport http pi-cloud ${location.origin}/api/mcp --header "Authorization: Bearer ${made.secret}"`}
            </pre>
          </div>
        )}
        <ul
          aria-label="MCP tokens"
          className="flex flex-col gap-1 rounded-lg border border-line bg-panel p-3 text-ui"
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
                  revoke(token.id);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      </Section>
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
