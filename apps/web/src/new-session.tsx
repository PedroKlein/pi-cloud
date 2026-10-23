import {
  type Environment,
  type Session,
  thinkingLevels,
} from "@pi-cloud/protocol";
import { Button, cn, Field, Icon } from "@pi-cloud/ui";
import {
  type ReactElement,
  type SubmitEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import { modelName, modelRef } from "./names";

const field =
  "h-9 w-full rounded-md border border-line bg-bg px-3 text-ui text-fg placeholder:text-fg-dim placeholder:font-sans focus:border-accent focus:outline-none";

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
  const message = useRef<HTMLTextAreaElement>(null);
  const [environmentId, setEnvironmentId] = useState("");
  const [kind, setKind] = useState("worktree");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      message.current?.focus();
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

    if (submitting) {
      return;
    }

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

    setSubmitting(true);

    api("/api/sessions", {
      environment: text("environment"),
      workspace: workspaceRequest(kind, text("location"), text("start-point")),
      model,
      ...(text("thinking") !== "" && { thinking: text("thinking") }),
      ...(text("first-message") !== "" && {
        firstMessage: text("first-message"),
      }),
    })
      .then(async (response) => {
        setError(undefined);
        setFormKey((key) => key + 1);
        onClose();
        location.hash = ((await response.json()) as Session).id;
      })
      .catch((reason: unknown) => {
        setError(`Couldn't start the session. ${String(reason)}`);
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="new-session-title"
      className="m-auto w-[min(640px,calc(100vw-32px))] rounded-xl border border-line bg-elevated p-0 text-fg shadow-pop backdrop:bg-black/50 max-sm:mb-0 max-sm:w-full max-sm:rounded-b-none"
    >
      <form
        key={formKey}
        id="create"
        onSubmit={submit}
        className="flex flex-col"
      >
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
          <div className="sm:col-span-2">
            <Field label="What should Pi do?">
              <textarea
                ref={message}
                name="first-message"
                rows={4}
                placeholder="Optional. Leave it empty to start in an idle session."
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                className={cn(field, "h-auto resize-y py-2")}
              />
            </Field>
          </div>
          <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
            <legend className="mb-1.5 text-label font-medium text-fg-dim">
              Environment
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {environments.map((e) => (
                <label
                  key={e.id}
                  className="flex cursor-pointer gap-3 rounded-lg border border-line bg-bg p-3 has-checked:border-accent has-checked:bg-accent-tint has-focus-visible:outline-2 has-focus-visible:outline-accent"
                >
                  <input
                    type="radio"
                    name="environment"
                    value={e.id}
                    required
                    checked={chosen?.id === e.id}
                    onChange={() => {
                      setEnvironmentId(e.id);
                    }}
                    className="sr-only"
                  />
                  <Icon name="monitor" className="mt-0.5 size-4 shrink-0" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-fg-strong">
                      {e.name}
                    </span>
                    <span className="truncate text-caption text-fg-dim">
                      {e.online ? "Online" : "Offline"} · {e.provider}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
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
          <Field label="Start from">
            <input
              name="start-point"
              placeholder="Current branch or commit"
              className={field}
            />
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
          <Field label="Model">
            <input
              name="model"
              placeholder="Environment default"
              list="models"
              className={`${field} font-mono text-mono-sm`}
            />
          </Field>
          <Field label="Reasoning">
            <select name="thinking" className={field}>
              <option value="">Model default</option>
              {thinkingLevels.map((level) => (
                <option key={level} value={level}>
                  {level === "off" ? "No reasoning" : level}
                </option>
              ))}
            </select>
          </Field>
          <datalist id="models">
            {(chosen?.models ?? []).map((model) => (
              <option key={modelName(model)} value={modelName(model)} />
            ))}
          </datalist>
        </div>

        <footer className="flex items-center gap-2 border-t border-line px-6 py-3">
          <div className="flex-1 text-caption">
            <p role="alert" className="text-failed">
              {error}
            </p>
            {error === undefined && (
              <p className="text-fg-dim max-sm:hidden">
                ⌘Enter starts the session
              </p>
            )}
          </div>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={submitting}>
            Start session
          </Button>
        </footer>
      </form>
    </dialog>
  );
}
