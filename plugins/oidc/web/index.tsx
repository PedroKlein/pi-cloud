import {
  json,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pipoca/plugins/web";
import { Button, Field, fieldClass, Section } from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import type { Account, ProviderInput, ProviderView } from "../src/model";

export const oidc: WebPlugin = {
  name: "oidc",
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

  if (value === undefined || (!value.admin && value.providers.length === 0)) {
    return null;
  }

  return (
    <Section title="Single sign-on">
      {value.providers.length > 0 && (
        <ul
          aria-label="Your sign-ins"
          className="flex flex-col gap-1 rounded-lg border border-line bg-elevated shadow-xs p-3 text-ui"
        >
          {value.providers.map((provider) => {
            const linked = value.identities.find(
              ({ issuer }) => issuer === provider.issuer,
            );

            return (
              <li key={provider.id} className="flex items-center gap-2">
                <span className="flex-1 truncate text-fg">
                  {provider.label}
                  <span className="text-fg-dim">
                    {linked === undefined
                      ? " · not linked"
                      : ` · you sign in as ${linked.email ?? "your linked account"}`}
                  </span>
                </span>
                {linked === undefined ? (
                  <Button
                    onClick={() => {
                      location.assign(
                        `/api/plugins/oidc/link/${encodeURIComponent(provider.id)}`,
                      );
                    }}
                  >
                    Link account
                  </Button>
                ) : (
                  !linked.created && (
                    <Button
                      onClick={() => {
                        void json(
                          context.request("unlink", {
                            method: "POST",
                            body: JSON.stringify({ issuer: linked.issuer }),
                          }),
                        ).then(reload, reload);
                      }}
                    >
                      Unlink
                    </Button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      {value.admin && <Providers context={context} onChange={reload} />}
    </Section>
  );
}

function Providers({
  context,
  onChange,
}: {
  readonly context: WebContext;
  readonly onChange: () => void;
}): ReactElement {
  const { value, reload } = useLoaded(
    async () => json<readonly ProviderView[]>(context.request("providers")),
    "providers",
  );

  const [editing, setEditing] = useState<ProviderView | "new">();

  const changed = (): void => {
    setEditing(undefined);
    reload();
    onChange();
  };

  const remove = (provider: ProviderView): void => {
    if (!confirm(`People won't be able to sign in with ${provider.label}.`)) {
      return;
    }

    void json(
      context.request(`providers/${encodeURIComponent(provider.id)}/remove`, {
        method: "POST",
      }),
    ).then(changed, changed);
  };

  return (
    <div className="flex flex-col gap-2 text-ui">
      <p className="text-fg-dim">
        Providers people can sign in with, kept in the server's pipoca.json.
        Register{" "}
        <code className="font-mono text-mono-sm">
          {location.origin}/api/plugins/oidc/callback
        </code>{" "}
        as the redirect URI with each one.
      </p>
      <ul
        aria-label="Providers"
        className="flex flex-col gap-1 rounded-lg border border-line bg-elevated shadow-xs p-3"
      >
        {value?.length === 0 && (
          <li className="text-fg-dim">No providers yet.</li>
        )}
        {value?.map((provider) => (
          <li key={provider.id} className="flex items-center gap-2">
            <span className="flex-1 truncate text-fg">
              {provider.label}
              <span className="text-fg-dim"> · {provider.issuer}</span>
            </span>
            <Button
              onClick={() => {
                setEditing(provider);
              }}
            >
              Edit
            </Button>
            <Button
              aria-label={`Remove ${provider.label}`}
              onClick={() => {
                remove(provider);
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
            Add provider
          </Button>
        </div>
      ) : (
        <ProviderForm
          key={editing === "new" ? "new" : editing.id}
          provider={editing === "new" ? undefined : editing}
          save={async (input) => {
            await json(
              context.request(
                editing === "new"
                  ? "providers"
                  : `providers/${encodeURIComponent(editing.id)}`,
                { method: "POST", body: JSON.stringify(input) },
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

function ProviderForm({
  provider,
  save,
  cancel,
}: {
  readonly provider: ProviderView | undefined;
  readonly save: (input: ProviderInput) => Promise<void>;
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

    const list = (name: string): readonly string[] =>
      text(name)
        .split(/[\s,]+/)
        .filter((each) => each !== "");

    const input: ProviderInput = {
      label: text("label"),
      issuer: text("issuer"),
      clientId: text("clientId"),
      clientSecret:
        form.get("removeSecret") === "on" ? null : text("clientSecret"),
      groupsClaim: text("groupsClaim"),
      accessGroup: text("accessGroup"),
      adminGroup: text("adminGroup"),
      allowedEmails: list("allowedEmails"),
      allowedDomains: list("allowedDomains"),
      adminEmails: list("adminEmails"),
    };

    save(input).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  const textField = (
    name:
      | "label"
      | "issuer"
      | "clientId"
      | "groupsClaim"
      | "accessGroup"
      | "adminGroup",
    label: string,
    placeholder?: string,
  ): ReactElement => (
    <Field label={label}>
      <input
        name={name}
        defaultValue={provider?.[name] ?? ""}
        placeholder={placeholder}
        className={fieldClass}
      />
    </Field>
  );

  const listField = (
    name: "allowedEmails" | "allowedDomains" | "adminEmails",
    label: string,
    placeholder: string,
  ): ReactElement => (
    <Field label={label}>
      <textarea
        name={name}
        rows={2}
        defaultValue={provider?.[name].join("\n") ?? ""}
        placeholder={placeholder}
        className={fieldClass}
      />
    </Field>
  );

  return (
    <form
      onSubmit={submit}
      aria-label={provider ? `Edit ${provider.label}` : "New provider"}
      className="grid gap-4 rounded-lg border border-line bg-elevated shadow-xs p-5 md:grid-cols-2"
    >
      {textField("label", "Button label", "Sign in with SAP IAS")}
      {textField("issuer", "Issuer", "https://tenant.accounts.ondemand.com")}
      {textField("clientId", "Client ID")}
      <Field label={secretLabel(provider)}>
        <input
          name="clientSecret"
          type="password"
          autoComplete="off"
          className={fieldClass}
        />
      </Field>
      {textField("groupsClaim", "Groups claim", "groups")}
      {textField("accessGroup", "Access group", "pipoca-users")}
      {textField("adminGroup", "Admin group", "pipoca-admins")}
      {listField("allowedEmails", "Allowed emails", "ana@example.com")}
      {listField("allowedDomains", "Allowed domains", "example.com")}
      {listField("adminEmails", "Admin emails", "ana@example.com")}
      {provider?.hasClientSecret === true && (
        <label className="flex items-center gap-2 text-fg-dim">
          <input type="checkbox" name="removeSecret" />
          Remove the client secret
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2 md:col-span-2">
        <Button variant="primary" type="submit">
          {provider ? "Save" : "Add provider"}
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

function secretLabel(provider: ProviderView | undefined): string {
  const env = provider?.clientSecretEnv ?? null;

  if (env !== null) {
    return `Client secret (from ${env}; leave empty to keep it)`;
  }

  return provider?.hasClientSecret === true
    ? "Client secret (set; leave empty to keep it)"
    : "Client secret (only if the provider requires one)";
}
