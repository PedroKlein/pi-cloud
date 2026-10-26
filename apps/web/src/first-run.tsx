import type { Environment, Session } from "@pi-cloud/protocol";
import { Button, cn, Icon } from "@pi-cloud/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { api } from "./api";

// Until a machine is connected and a model logged in, the home screen says
// what's left, one step at a time (ADR 0040).
export function FirstRun({
  environments,
}: {
  readonly environments: readonly Environment[];
}): ReactElement | null {
  const connected = environments.find(
    ({ online, onDemand }) => online || onDemand,
  );

  const loggedIn = environments.some(({ models }) => models.length > 0);

  if (connected !== undefined && loggedIn) {
    return null;
  }

  return (
    <section
      aria-label="Get started"
      className="mx-auto mt-8 flex w-full max-w-2xl flex-col gap-1 px-4"
    >
      <h2 className="text-label font-medium text-fg-dim">Get started</h2>
      <ol className="flex flex-col divide-y divide-line rounded-xl border border-line bg-elevated">
        <Step title="Connect a machine" done={connected !== undefined}>
          <ConnectMachine />
        </Step>
        <Step title="Log in to a model" done={loggedIn}>
          {connected === undefined ? (
            <p className="text-fg-dim">
              Once a machine is connected, log in to a model provider on it.
            </p>
          ) : (
            <LogIn environment={connected} />
          )}
        </Step>
      </ol>
    </section>
  );
}

function Step({
  title,
  done,
  children,
}: {
  readonly title: string;
  readonly done: boolean;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <li className="flex gap-3 p-4">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border",
          done ? "border-done bg-done text-on-accent" : "border-line",
        )}
      >
        {done && <Icon name="check" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 text-ui">
        <h3 className="font-medium text-fg-strong">
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </h3>
        {!done && children}
      </div>
    </li>
  );
}

function ConnectMachine(): ReactElement {
  const [key, setKey] = useState<string>();
  const [error, setError] = useState<string>();

  if (key === undefined) {
    return (
      <>
        <p className="text-fg-dim">
          Run one command on the machine Pi should work on, in the folder it
          should work in.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            className="self-start"
            onClick={() => {
              api("/api/join-key", {})
                .then(async (response) => {
                  setKey(((await response.json()) as { key: string }).key);
                })
                .catch((reason: unknown) => {
                  setError(`Couldn't make a key. ${String(reason)}`);
                });
            }}
          >
            Show the command
          </Button>
          {error !== undefined && (
            <p role="alert" className="text-caption text-failed">
              {error}
            </p>
          )}
        </div>
      </>
    );
  }

  const command = `PI_CLOUD_KEY=${key} pi-cloud agent --server ${location.origin}`;

  return (
    <>
      <p className="text-fg-dim">
        The key is shown only now. The machine shows up under its own name.
      </p>
      <div className="flex items-start gap-2">
        <pre
          aria-label="Join command"
          className="min-w-0 flex-1 rounded-md border border-line bg-panel p-3 font-mono text-mono-sm break-all whitespace-pre-wrap"
        >
          {command}
        </pre>
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(command);
          }}
        >
          Copy
        </Button>
      </div>
      <p className="text-caption text-fg-dim" aria-live="polite">
        Waiting for the machine to connect…
      </p>
    </>
  );
}

function LogIn({
  environment,
}: {
  readonly environment: Environment;
}): ReactElement {
  const [error, setError] = useState<string>();
  const [folder] = environment.folders;

  if (folder === undefined) {
    return (
      <p className="text-fg-dim">
        Start a session on {environment.name} and log in from its model menu.
      </p>
    );
  }

  return (
    <>
      <p className="text-fg-dim">
        A session on {environment.name} runs <code>/login</code>, and you pick a
        provider there.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          className="self-start"
          onClick={() => {
            api("/api/sessions", {
              environment: environment.id,
              workspace: { kind: "folder", path: folder },
              firstMessage: "/login",
            })
              .then(async (response) => {
                location.hash = ((await response.json()) as Session).id;
              })
              .catch((reason: unknown) => {
                setError(`Couldn't start the session. ${String(reason)}`);
              });
          }}
        >
          Log in
        </Button>
        {error !== undefined && (
          <p role="alert" className="text-caption text-failed">
            {error}
          </p>
        )}
      </div>
    </>
  );
}
