import {
  json,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pipoca/plugins/web";
import { Button, Field, fieldClass, Section } from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import type { Account, HostInput, HostView } from "../src/model";

export const gitHosts: WebPlugin = {
  name: "git-hosts",
  SettingsSection,
};

function SettingsSection({
  context,
}: {
  readonly context: WebContext;
}): ReactElement | null {
  const { value, reload } = useLoaded(
    async () => json<Account>(context.request("account")),
    "account",
  );

  if (value === undefined) {
    return null;
  }

  return (
    <Section title="Git hosts">
      <p className="text-ui text-fg-dim">
        Your Sessions clone, push, use gh and install Profile packages as the
        accounts you connect here.
      </p>
      <ul
        aria-label="Your git hosts"
        className="flex flex-col gap-2 rounded-lg border border-line bg-elevated shadow-xs p-3 text-ui"
      >
        {value.hosts.length === 0 && (
          <li className="text-fg-dim">No hosts are listed yet.</li>
        )}
        {value.hosts.map((host) => (
          <HostRow
            key={host.host}
            context={context}
            host={host}
            login={
              value.connections.find((each) => each.host === host.host)?.login
            }
            onChange={reload}
          />
        ))}
      </ul>
      {value.admin && <Hosts context={context} onChange={reload} />}
    </Section>
  );
}

function HostRow({
  context,
  host,
  login,
  onChange,
}: {
  readonly context: WebContext;
  readonly host: Account["hosts"][number];
  readonly login: string | undefined;
  readonly onChange: () => void;
}): ReactElement {
  const [pasting, setPasting] = useState(false);
  const [error, setError] = useState<string>();

  const connect = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const token = new FormData(event.currentTarget).get("token");

    json(context.request("connect", { host: host.host, token })).then(
      () => {
        setPasting(false);
        setError(undefined);
        onChange();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <li className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-fg">
          {host.label}
          <span className="text-fg-dim">
            {host.label === host.host ? "" : ` · ${host.host}`}
            {login === undefined ? " · not connected" : ` · you are ${login}`}
          </span>
        </span>
        {login === undefined ? (
          <>
            {host.oauth && (
              <Button
                variant="primary"
                onClick={() => {
                  location.assign(
                    `/api/plugins/git-hosts/sign-in/${encodeURIComponent(host.host)}`,
                  );
                }}
              >
                Connect
              </Button>
            )}
            {!pasting && (
              <Button
                onClick={() => {
                  setPasting(true);
                }}
              >
                Use a token
              </Button>
            )}
          </>
        ) : (
          <Button
            aria-label={`Disconnect ${host.label}`}
            onClick={() => {
              void json(
                context.request("disconnect", { host: host.host }),
              ).then(onChange, onChange);
            }}
          >
            Disconnect
          </Button>
        )}
      </div>
      {pasting && login === undefined && (
        <form
          onSubmit={connect}
          aria-label={`Connect ${host.label} with a token`}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            name="token"
            type="password"
            autoComplete="off"
            aria-label="Personal access token"
            placeholder="Personal access token with repo scope"
            className={`${fieldClass} flex-1`}
          />
          <Button variant="primary" type="submit">
            Connect
          </Button>
          <Button
            onClick={() => {
              setPasting(false);
            }}
          >
            Cancel
          </Button>
          {error !== undefined && (
            <p role="alert" className="w-full text-caption text-failed">
              {error}
            </p>
          )}
        </form>
      )}
    </li>
  );
}

function Hosts({
  context,
  onChange,
}: {
  readonly context: WebContext;
  readonly onChange: () => void;
}): ReactElement {
  const { value, reload } = useLoaded(
    async () => json<readonly HostView[]>(context.request("hosts")),
    "hosts",
  );

  const [editing, setEditing] = useState<HostView | "new">();

  const changed = (): void => {
    setEditing(undefined);
    reload();
    onChange();
  };

  const remove = (host: HostView): void => {
    if (!confirm(`Sessions will stop signing in to ${host.host}.`)) {
      return;
    }

    void json(
      context.request(`hosts/${encodeURIComponent(host.host)}/remove`, {}),
    ).then(changed, changed);
  };

  return (
    <div className="flex flex-col gap-2 text-ui">
      <p className="text-fg-dim">
        Hosts people can connect, kept in the server's pipoca.json. For a
        Connect button, register an OAuth app on the host with{" "}
        <code className="font-mono text-mono-sm">
          {location.origin}/api/plugins/git-hosts/callback
        </code>{" "}
        as its callback URL.
      </p>
      <ul
        aria-label="Hosts"
        className="flex flex-col gap-1 rounded-lg border border-line bg-elevated shadow-xs p-3"
      >
        {value?.map((host) => (
          <li key={host.host} className="flex items-center gap-2">
            <span className="flex-1 truncate text-fg">
              {host.label}
              <span className="text-fg-dim">
                {" "}
                · {host.host}
                {host.clientId === "" ? " · tokens" : " · OAuth app"}
              </span>
            </span>
            <Button
              onClick={() => {
                setEditing(host);
              }}
            >
              Edit
            </Button>
            <Button
              aria-label={`Remove ${host.host}`}
              onClick={() => {
                remove(host);
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {editing === undefined ? (
        <div>
          <Button
            onClick={() => {
              setEditing("new");
            }}
          >
            Add host
          </Button>
        </div>
      ) : (
        <HostForm
          key={editing === "new" ? "new" : editing.host}
          host={editing === "new" ? undefined : editing}
          save={async (input) => {
            await json(
              context.request(
                editing === "new"
                  ? "hosts"
                  : `hosts/${encodeURIComponent(editing.host)}`,
                input,
              ),
            );

            changed();
          }}
          cancel={() => {
            setEditing(undefined);
          }}
        />
      )}
    </div>
  );
}

function HostForm({
  host,
  save,
  cancel,
}: {
  readonly host: HostView | undefined;
  readonly save: (input: HostInput) => Promise<void>;
  readonly cancel: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value : "";
    };

    save({
      host: host?.host ?? text("host"),
      label: text("label"),
      clientId: text("clientId"),
      clientSecret:
        form.get("removeSecret") === "on" ? null : text("clientSecret"),
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  return (
    <form
      onSubmit={submit}
      aria-label={host ? `Edit ${host.host}` : "New host"}
      className="grid gap-4 rounded-lg border border-line bg-elevated shadow-xs p-5 md:grid-cols-2"
    >
      <Field label="Host">
        <input
          name="host"
          defaultValue={host?.host ?? ""}
          disabled={host !== undefined}
          placeholder="github.example.com"
          className={fieldClass}
        />
      </Field>
      <Field label="Label">
        <input
          name="label"
          defaultValue={host?.label ?? ""}
          placeholder="Company GitHub"
          className={fieldClass}
        />
      </Field>
      <Field label="OAuth app client ID (optional)">
        <input
          name="clientId"
          defaultValue={host?.clientId ?? ""}
          className={fieldClass}
        />
      </Field>
      <Field label={secretLabel(host)}>
        <input
          name="clientSecret"
          type="password"
          autoComplete="off"
          className={fieldClass}
        />
      </Field>
      {host?.hasClientSecret === true && (
        <label className="flex items-center gap-2 text-fg-dim">
          <input type="checkbox" name="removeSecret" />
          Remove the client secret
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2 md:col-span-2">
        <Button variant="primary" type="submit">
          {host ? "Save" : "Add host"}
        </Button>
        <Button onClick={cancel}>Cancel</Button>
        {error !== undefined && (
          <p role="alert" className="text-caption text-failed">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

function secretLabel(host: HostView | undefined): string {
  const env = host?.clientSecretEnv ?? null;

  if (env !== null) {
    return `Client secret (from ${env}; leave empty to keep it)`;
  }

  return host?.hasClientSecret === true
    ? "Client secret (set; leave empty to keep it)"
    : "OAuth app client secret";
}
