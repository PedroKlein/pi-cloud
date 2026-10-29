import { json, useLoaded, type WebContext } from "@pipoca/plugins/web";
import { Button, Field, fieldClass, Select } from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import type { Connectable, Connection, ConnectionPrompt } from "../src/model";

type Send = (path: string, init: RequestInit) => void;

// Picks a provider and a way in, and asks the server to sign the person in.
export function ConnectForm({
  context,
  send,
  onClose,
}: {
  readonly context: WebContext;
  readonly send: Send;
  readonly onClose: () => void;
}): ReactElement | null {
  const { value: providers } = useLoaded(
    async () => json<readonly Connectable[]>(context.request("providers")),
    "providers",
  );

  const [providerId, setProviderId] = useState<string>();

  if (providers === undefined) {
    return null;
  }

  const provider =
    providers.find(({ id }) => id === providerId) ?? providers[0];

  const connect = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();

    send("connect", {
      method: "POST",
      body: JSON.stringify({
        provider: provider?.id,
        type: new FormData(event.currentTarget).get("type"),
      }),
    });
  };

  return (
    <form
      aria-label="Connect a model provider"
      onSubmit={connect}
      className="flex flex-col gap-3 rounded-lg border border-line bg-elevated shadow-xs p-3"
    >
      <Field label="Provider">
        <Select
          value={provider?.id}
          onChange={(event) => {
            setProviderId(event.target.value);
          }}
        >
          {providers.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Log in with">
        <Select key={provider?.id} name="type">
          {provider?.methods.map(({ type, label }) => (
            <option key={type} value={type}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex gap-2">
        <Button variant="primary" type="submit">
          Connect
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

// Shows the sign-in the server runs for the person: links to open, codes to
// enter and Pi's prompts, until it's done.
export function ConnectionCard({
  connection,
  send,
}: {
  readonly connection: Connection;
  readonly send: Send;
}): ReactElement {
  const { name } = connection;

  const dismiss = (): void => {
    send("connection", { method: "DELETE" });
  };

  return (
    <section
      aria-label={`Connecting ${name}`}
      className="flex flex-col gap-3 rounded-lg border border-line bg-elevated shadow-xs p-3 text-ui"
    >
      <p className="font-medium text-fg">
        {connection.state === "done"
          ? `Connected to ${name}.`
          : `Connecting ${name}`}
      </p>
      {connection.events.map((event, index) => (
        <ConnectionEvent key={index} event={event} />
      ))}
      {connection.prompt !== undefined && (
        <PromptForm
          key={connection.prompt.id}
          prompt={connection.prompt}
          send={send}
        />
      )}
      {connection.state === "failed" && (
        <p role="alert" className="text-caption text-failed">
          {connection.error ?? "The sign-in didn't finish."}
        </p>
      )}
      <div>
        <Button onClick={dismiss}>
          {connection.state === "running" ? "Cancel" : "Close"}
        </Button>
      </div>
    </section>
  );
}

function ConnectionEvent({
  event,
}: {
  readonly event: Connection["events"][number];
}): ReactElement {
  switch (event.type) {
    case "auth_url":
      return (
        <p className="flex flex-col gap-1 text-fg">
          <a
            href={event.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent underline"
          >
            Open the sign-in page
          </a>
          {event.instructions !== undefined && (
            <span className="text-fg-dim">{event.instructions}</span>
          )}
        </p>
      );
    case "device_code":
      return (
        <p className="flex flex-col gap-1 text-fg">
          <span>
            Enter the code{" "}
            <code className="font-mono font-medium">{event.userCode}</code> on{" "}
            <a
              href={event.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-accent underline"
            >
              the sign-in page
            </a>
            .
          </span>
        </p>
      );
    case "info":
      return (
        <p className="flex flex-col gap-1 text-fg-dim">
          {event.message}
          {event.links?.map(({ url, label }) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline"
            >
              {label ?? url}
            </a>
          ))}
        </p>
      );
    case "progress":
      return <p className="text-fg-dim">{event.message}</p>;
  }
}

function PromptForm({
  prompt,
  send,
}: {
  readonly prompt: ConnectionPrompt;
  readonly send: Send;
}): ReactElement {
  const answer = (value: unknown): void => {
    send("connection/answer", {
      method: "POST",
      body: JSON.stringify({ prompt: prompt.id, answer: value }),
    });
  };

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    answer(new FormData(event.currentTarget).get("answer"));
  };

  return (
    <form
      aria-label={prompt.message}
      onSubmit={submit}
      className="flex flex-col gap-2"
    >
      <Field label={prompt.message}>
        {prompt.type === "select" ? (
          <Select name="answer">
            {prompt.options?.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
        ) : (
          <input
            name="answer"
            type={prompt.type === "secret" ? "password" : "text"}
            autoComplete="off"
            placeholder={prompt.placeholder}
            className={fieldClass}
          />
        )}
      </Field>
      <div>
        <Button variant="primary" type="submit">
          Continue
        </Button>
      </div>
    </form>
  );
}
