import type { Environment, Session } from "@pi-cloud/protocol";
import { Button, Icon } from "@pi-cloud/ui";
import {
  type ReactElement,
  type ReactNode,
  type SubmitEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import { modelName, modelRef } from "./names";

const field =
  "h-9 w-full rounded-md border border-line bg-bg px-3 text-ui text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none";

function workspaceRequest(
  kind: string,
  where: string,
  startPoint: string,
): unknown {
  switch (kind) {
    case "clone":
      return { kind, repository: where, startPoint };
    case "repositories":
      return {
        kind,
        repositories: where
          .split(/\s+/)
          .filter((url) => url !== "")
          .map((repository) => ({ repository, startPoint })),
      };
    default:
      return { kind, path: where, startPoint };
  }
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-label font-medium text-fg-dim">{label}</span>
      {children}
    </label>
  );
}

export function NewSessionDialog({
  open,
  environments,
  onClose,
}: {
  readonly open: boolean;
  readonly environments: readonly Environment[];
  readonly onClose: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const [environmentId, setEnvironmentId] = useState("");
  const [kind, setKind] = useState("worktree");
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
    }
  }, [open]);

  const chosen =
    environments.find((e) => e.id === environmentId) ?? environments[0];

  const folders =
    kind === "folder" || kind === "worktree" ? (chosen?.folders ?? []) : [];

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value.trim() : "";
    };

    const model = text("model") === "" ? null : modelRef(text("model"));

    if (model === undefined) {
      setError("Write the model as provider/id.");

      return;
    }

    api("/api/sessions", {
      environment: text("environment"),
      workspace: workspaceRequest(kind, text("location"), text("start-point")),
      model,
    })
      .then(async (response) => {
        setError(undefined);
        onClose();
        location.hash = ((await response.json()) as Session).id;
      })
      .catch((reason: unknown) => {
        setError(`Couldn't start the session. ${String(reason)}`);
      });
  };

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="new-session-title"
      className="m-auto w-[min(640px,calc(100vw-32px))] rounded-xl border border-line bg-elevated p-0 text-fg shadow-pop backdrop:bg-black/50 max-sm:mb-0 max-sm:w-full max-sm:rounded-b-none"
    >
      <form id="create" onSubmit={submit} className="flex flex-col">
        <header className="flex items-center gap-2 pt-4 pr-4 pb-2 pl-6">
          <h2
            id="new-session-title"
            className="flex-1 text-title font-semibold text-fg-strong"
          >
            New session
          </h2>
          <Button variant="ghost" iconOnly aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </Button>
        </header>

        <div className="grid gap-4 px-6 pt-2 pb-6 sm:grid-cols-2">
          <Field label="Environment">
            <select
              name="environment"
              required
              value={chosen?.id ?? ""}
              onChange={(event) => {
                setEnvironmentId(event.target.value);
              }}
              className={field}
            >
              {environments.map((e) => (
                <option
                  key={e.id}
                  value={e.id}
                  label={`${e.name} (${e.provider}, ${e.online ? "online" : "offline"})`}
                />
              ))}
            </select>
          </Field>
          <Field label="Workspace">
            <select
              name="kind"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
              }}
              className={field}
            >
              <option value="worktree">Worktree of a folder</option>
              <option value="folder">Folder, shared with other sessions</option>
              <option value="clone">Clone of a repository</option>
              <option value="repositories">Several repositories</option>
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field
              label={
                kind === "repositories"
                  ? "Repository URLs, separated by spaces"
                  : "Folder or repository URL"
              }
            >
              <input
                name="location"
                required
                list="folders"
                className={field}
              />
            </Field>
          </div>
          <datalist id="folders">
            {folders.map((folder) => (
              <option key={folder} value={folder} />
            ))}
          </datalist>
          <Field label="Start from">
            <input
              name="start-point"
              placeholder="Current branch or commit"
              className={field}
            />
          </Field>
          <Field label="Model">
            <input
              name="model"
              placeholder="Environment default"
              list="models"
              className={`${field} font-mono text-code-sm`}
            />
          </Field>
          <datalist id="models">
            {(chosen?.models ?? []).map((model) => (
              <option key={modelName(model)} value={modelName(model)} />
            ))}
          </datalist>
        </div>

        <footer className="flex items-center gap-2 border-t border-line px-6 py-3">
          <p role="alert" className="flex-1 text-caption text-failed">
            {error}
          </p>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Start session
          </Button>
        </footer>
      </form>
    </dialog>
  );
}
