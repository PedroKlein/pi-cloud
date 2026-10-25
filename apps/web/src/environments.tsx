import type { Environment } from "@pi-cloud/protocol";
import {
  Badge,
  Button,
  cn,
  Field,
  fieldClass,
  PageTitle,
  Section,
} from "@pi-cloud/ui";
import { type ReactElement, type SubmitEvent, useRef, useState } from "react";
import { api, send } from "./api";
import { variablesOf, variablesText } from "./variables";

export function EnvironmentsPage({
  environments,
  selected,
  onChange,
}: {
  readonly environments: readonly Environment[];
  readonly selected: string;
  readonly onChange: () => void;
}): ReactElement {
  const environment =
    environments.find(({ id }) => id === selected) ?? environments[0];

  // A key shows once, right after it is made (ADR 0033).
  const [madeKey, setMadeKey] = useState<{
    readonly environmentId: string;
    readonly key: string;
  }>();

  return (
    <div
      id="environments-page"
      className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 md:px-10"
    >
      <PageTitle description="An Environment is where Sessions run: a pool of machines whose agents joined it, with a setup script, variables and secrets for every Session. Edits reach a Session the next time it starts.">
        Environments
      </PageTitle>
      <div className="flex flex-wrap gap-2">
        {environments.map((each) => (
          <a
            key={each.id}
            href={`#environments/${each.id}`}
            aria-current={each.id === environment?.id ? "page" : undefined}
            className="flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-1.5 text-ui text-fg hover:bg-hover aria-[current=page]:border-accent aria-[current=page]:text-fg-strong"
          >
            {each.name}
            <Badge state={each.online ? "done" : "offline"}>
              {each.online ? "Online" : "Offline"}
            </Badge>
          </a>
        ))}
      </div>
      <NewEnvironment
        onCreated={(environmentId, key) => {
          setMadeKey({ environmentId, key });
          onChange();
          location.hash = `#environments/${environmentId}`;
        }}
      />
      {environment && (
        <Editor
          key={environment.id}
          environment={environment}
          madeKey={
            madeKey?.environmentId === environment.id ? madeKey.key : undefined
          }
          onKey={(key) => {
            setMadeKey({ environmentId: environment.id, key });
            onChange();
          }}
          onChange={onChange}
        />
      )}
    </div>
  );
}

function NewEnvironment({
  onCreated,
}: {
  readonly onCreated: (environmentId: string, key: string) => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = new FormData(form).get("name");

    void api("/api/environments", { name })
      .then(async (response) => {
        const created = (await response.json()) as {
          readonly environment: Environment;
          readonly key: string;
        };

        setError(undefined);
        form.reset();
        onCreated(created.environment.id, created.key);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return (
    <form
      onSubmit={submit}
      aria-label="New Environment"
      className="mt-4 flex flex-wrap items-center gap-2"
    >
      <input
        name="name"
        required
        aria-label="New Environment name"
        placeholder="laptops"
        className={cn(fieldClass, "w-48 font-mono")}
      />
      <Button type="submit">New Environment</Button>
      {error !== undefined && (
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      )}
    </form>
  );
}

function JoinKey({
  environment,
  madeKey,
  onKey,
}: {
  readonly environment: Environment;
  readonly madeKey: string | undefined;
  readonly onKey: (key: string) => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const replace = (): void => {
    if (
      environment.hasKey &&
      !confirm(
        "Agents that joined with the current key will have to join again with the new one.",
      )
    ) {
      return;
    }

    void api(`/api/environments/${environment.id}/key`, {})
      .then(async (response) => {
        onKey(((await response.json()) as { readonly key: string }).key);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return (
    <div className="mt-3 flex flex-col gap-2 text-ui">
      {madeKey === undefined ? (
        <p className="text-fg-dim">
          {environment.hasKey
            ? "Agents join with this Environment's key, which was shown when it was made."
            : "No agent can join until the Environment has a key."}
        </p>
      ) : (
        <>
          <p className="text-fg-dim">
            Start an agent with this key. It is shown only now.
          </p>
          <pre
            aria-label="Join command"
            className="overflow-x-auto rounded-md border border-line bg-elevated p-3 font-mono text-mono-sm"
          >
            {`PI_CLOUD_KEY=${madeKey} pi-cloud agent --name <machine> --server ${location.origin}`}
          </pre>
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={replace}>
          {environment.hasKey ? "Replace key" : "Make key"}
        </Button>
        {error !== undefined && (
          <p role="alert" className="text-caption text-failed">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function Editor({
  environment,
  madeKey,
  onKey,
  onChange,
}: {
  readonly environment: Environment;
  readonly madeKey: string | undefined;
  readonly onKey: (key: string) => void;
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  // What the form's fields started from. Only fields edited since are sent,
  // so a save keeps changes made elsewhere meanwhile.
  const shown = useRef<Readonly<Record<string, string>>>(fieldsOf(environment));

  const update = (body: unknown, then?: () => void): void => {
    setSaved(false);

    send(`/api/environments/${environment.id}`, "PATCH", body).then(
      () => {
        setError(undefined);
        setSaved(true);
        then?.();
        onChange();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);

    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value : "";
    };

    const fields = Object.fromEntries(
      Object.keys(shown.current).map((name) => [name, text(name)]),
    );

    const edited = (name: string): boolean =>
      fields[name] !== shown.current[name];

    try {
      const image = text("image").trim();

      update(
        {
          ...(edited("name") && { name: text("name") }),
          ...(edited("isolation") && { isolation: text("isolation") }),
          ...(edited("image") && { image: image === "" ? null : image }),
          ...(edited("setupScript") && { setupScript: text("setupScript") }),
          ...(edited("variables") && {
            variables: variablesOf(text("variables")),
          }),
          secrets: variablesOf(text("secrets")),
        },
        () => {
          shown.current = fields;

          const secrets = formElement.elements.namedItem("secrets");
          if (secrets instanceof HTMLTextAreaElement) {
            secrets.value = "";
          }
        },
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const area = cn(fieldClass, "min-h-24 resize-y font-mono text-mono-sm");

  return (
    <>
      <Section title="Machines">
        <ul className="flex flex-col gap-1 rounded-lg border border-line bg-panel p-3 text-ui">
          {environment.runners.length === 0 && (
            <li className="text-fg-dim">
              No agent has joined since the server started.
            </li>
          )}
          {environment.runners.map((runner) => (
            <li key={runner.name} className="flex items-center gap-2">
              <span className="font-mono">{runner.name}</span>
              <Badge state={runner.online ? "done" : "offline"}>
                {runner.online ? "Online" : "Offline"}
              </Badge>
              <span className="text-caption text-fg-dim">
                {runner.capacity === null
                  ? `${String(runner.running)} running`
                  : `${String(runner.running)} of ${String(runner.capacity)} running`}
              </span>
            </li>
          ))}
        </ul>
        <JoinKey environment={environment} madeKey={madeKey} onKey={onKey} />
      </Section>
      <Section title={environment.name}>
        <form
          onSubmit={submit}
          className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5"
        >
          <Field label="Name">
            <input
              name="name"
              required
              defaultValue={environment.name}
              className={fieldClass}
            />
          </Field>
          <Field label="Run each Session">
            <select
              name="isolation"
              defaultValue={environment.isolation}
              className={fieldClass}
            >
              <option value="process">As a process on its machine</option>
              <option value="container">In a container (needs Docker)</option>
            </select>
          </Field>
          <Field label="Container image, empty for the default">
            <input
              name="image"
              defaultValue={environment.image ?? ""}
              placeholder="node:22-bookworm"
              className={cn(fieldClass, "font-mono")}
            />
          </Field>
          <Field label="Setup script, run once per machine or image before its first Session">
            <textarea
              name="setupScript"
              rows={4}
              defaultValue={environment.setupScript}
              placeholder="apt-get install -y ripgrep"
              className={area}
            />
          </Field>
          <Field label="Variables, one NAME=value per line">
            <textarea
              name="variables"
              rows={3}
              defaultValue={variablesText(environment.variables)}
              className={area}
            />
          </Field>
          <Field label="New or replaced secrets, one NAME=value per line. GH_TOKEN also signs git in to GitHub.">
            <textarea
              name="secrets"
              rows={2}
              placeholder="GH_TOKEN=…"
              className={area}
            />
          </Field>
          {environment.secrets.length > 0 && (
            <ul aria-label="Secrets" className="flex flex-wrap gap-2">
              {environment.secrets.map((name) => (
                <li
                  key={name}
                  className="flex items-center gap-1 rounded-md border border-line px-2 py-1 font-mono text-mono-sm"
                >
                  {name}
                  <Button
                    variant="ghost"
                    aria-label={`Remove ${name}`}
                    onClick={() => {
                      update({ secrets: { [name]: null } });
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" type="submit">
              Save
            </Button>
            <p role="status" className="text-caption">
              {error !== undefined ? (
                <span className="text-failed">{error}</span>
              ) : (
                saved && <span className="text-fg-dim">Saved</span>
              )}
            </p>
          </div>
        </form>
      </Section>
    </>
  );
}

function fieldsOf(environment: Environment): Record<string, string> {
  return {
    name: environment.name,
    isolation: environment.isolation,
    image: environment.image ?? "",
    setupScript: environment.setupScript,
    variables: variablesText(environment.variables),
  };
}
