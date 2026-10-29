import {
  availability,
  type Environment,
  type Profile,
  type RepositoryChoice,
  type Session,
  type ThinkingLevel,
  thinkingLevels,
} from "@pipoca/protocol";
import {
  Button,
  Icon,
  isComposing,
  Picker,
  type PickerOption,
  Slider,
} from "@pipoca/ui";
import {
  type ReactElement,
  type SubmitEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { modelOptions, rememberModel } from "@pipoca/plugins/web";
import { api } from "./api";
import { modelRef } from "./names";
import { searchRepositories } from "./plugins";

// Typing searches the git hosts once it pauses for this long.
const searchDelayMs = 250;

// The New session composer remembers its last choices in this browser, like
// Claude Code's (ADR 0040).
interface Choices {
  readonly environment: string;
  readonly where: readonly string[];
  readonly share: boolean;
  readonly model: string;
  readonly thinking: ThinkingLevel | "";
  readonly profile: string;
}

const choicesKey = "pipoca.new-session";

const fresh: Choices = {
  environment: "",
  where: [],
  share: false,
  model: "",
  thinking: "",
  profile: "",
};

function remembered(): Choices {
  try {
    const saved = localStorage.getItem(choicesKey);

    return saved === null
      ? fresh
      : { ...fresh, ...(JSON.parse(saved) as Partial<Choices>) };
  } catch {
    return fresh;
  }
}

function remember(choices: Choices): void {
  try {
    localStorage.setItem(choicesKey, JSON.stringify(choices));
  } catch {
    // The choices only last this visit.
  }
}

function isRepository(where: string): boolean {
  return where.includes("://") || /^[\w.-]+@[\w.-]+:/.test(where);
}

function lastSegment(where: string): string {
  return (
    where
      .replace(/[/\\]+$/, "")
      .split(/[/:\\]/)
      .at(-1)
      ?.replace(/\.git$/, "") ?? where
  );
}

// The workspace kind follows from what was picked (ADR 0040).
function workspaceRequest(
  where: readonly string[],
  share: boolean,
  startPoint: string,
): unknown {
  const [only] = where;

  if (where.length === 1 && only !== undefined) {
    if (isRepository(only)) {
      return { kind: "clone", repository: only, startPoint };
    }

    return { kind: share ? "folder" : "worktree", path: only, startPoint };
  }

  return {
    kind: "repositories",
    repositories: where.map((repository) => ({ repository, startPoint })),
  };
}

function recentPlaces(
  sessions: readonly Session[],
  environmentId: string | undefined,
): string[] {
  const places = [...sessions]
    .filter((session) => session.environmentId === environmentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .flatMap(({ workspace }) => {
      switch (workspace.kind) {
        case "folder":
        case "worktree":
          return [workspace.path];
        case "clone":
          return [workspace.repository];
        case "repositories":
          return workspace.repositories.map(({ repository }) => repository);
      }
    });

  return [...new Set(places)].slice(0, 5);
}

function placeOption(where: string, group: string): PickerOption {
  return { value: where, label: lastSegment(where), detail: where, group };
}

export function NewSessionDialog({
  open,
  environments,
  profiles,
  sessions,
  onClose,
}: {
  readonly open: boolean;
  readonly environments: readonly Environment[];
  readonly profiles: readonly Profile[];
  readonly sessions: readonly Session[];
  readonly onClose: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const message = useRef<HTMLTextAreaElement>(null);
  const [choices, setChoices] = useState(remembered);
  const [text, setText] = useState("");
  const [startPoint, setStartPoint] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [found, setFound] = useState<readonly RepositoryChoice[]>([]);
  const searches = useRef(0);

  // Only the latest search's answer is shown, whichever arrives first.
  const search = (query: string): void => {
    const ticket = ++searches.current;

    setTimeout(
      () => {
        if (ticket !== searches.current) {
          return;
        }

        void searchRepositories(query).then((repositories) => {
          if (ticket === searches.current) {
            setFound(repositories);
          }
        });
      },
      query === "" ? 0 : searchDelayMs,
    );
  };

  const opened = useEffectEvent(() => {
    search("");
  });

  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      message.current?.focus();
      opened();
    } else {
      dialog.current?.close();
    }
  }, [open]);

  const choose = (change: Partial<Choices>): void => {
    setChoices((current) => ({ ...current, ...change }));
  };

  const chosen =
    environments.find(({ id }) => id === choices.environment) ??
    environments[0];

  const profile =
    profiles.find(({ id }) => id === choices.profile) ??
    profiles.find(({ isDefault }) => isDefault);

  const recent = recentPlaces(sessions, chosen?.id);

  const places = [
    ...recent.map((where) => placeOption(where, "Recent")),
    ...(chosen?.folders ?? [])
      .filter((folder) => !recent.includes(folder))
      .map((folder) => placeOption(folder, `On ${chosen?.name ?? ""}`)),
    ...choices.where
      .filter(
        (where) =>
          !recent.includes(where) &&
          !(chosen?.folders.includes(where) ?? false),
      )
      .map((where) => placeOption(where, "Picked")),
  ];

  const offered = [
    ...places,
    ...found
      .filter(({ url }) => !places.some(({ value }) => value === url))
      .map(({ url, name, group }) => ({
        value: url,
        label: name,
        detail: URL.parse(url)?.host ?? url,
        group,
      })),
  ];

  const { options: modelChoices, openGroups } = modelOptions(
    chosen?.models ?? [],
  );

  const sharing =
    choices.share &&
    choices.where.length === 1 &&
    !choices.where.some(isRepository);

  const submit = (event?: SubmitEvent<HTMLFormElement>): void => {
    event?.preventDefault();

    if (submitting) {
      return;
    }

    if (choices.where.length === 0) {
      setError("Pick a folder or repository to work in.");

      return;
    }

    if (choices.where.length > 1 && !choices.where.every(isRepository)) {
      setError("Several repositories need their URLs, not folders.");

      return;
    }

    const model = choices.model === "" ? null : modelRef(choices.model);

    setSubmitting(true);
    remember(choices);

    api("/api/sessions", {
      environment: chosen?.id,
      workspace: workspaceRequest(choices.where, choices.share, startPoint),
      model,
      ...(profile && { profile: profile.id }),
      ...(choices.thinking !== "" && { thinking: choices.thinking }),
      ...(text.trim() !== "" && { firstMessage: text.trim() }),
    })
      .then(async (response) => {
        setError(undefined);
        setText("");
        setStartPoint("");
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
      className="m-auto w-[min(680px,calc(100vw-32px))] overflow-visible rounded-xl border border-line bg-elevated p-0 text-fg shadow-pop backdrop:bg-black/30 backdrop:backdrop-blur-[2px] open:animate-pop-in max-sm:mb-0 max-sm:w-full max-sm:rounded-b-none"
    >
      <form id="create" onSubmit={submit} className="flex flex-col">
        <header className="flex items-center gap-2 pt-3 pr-3 pb-1 pl-5">
          <h2
            id="new-session-title"
            className="flex-1 text-ui font-semibold text-fg-strong"
          >
            New session
          </h2>
          <Button variant="ghost" iconOnly aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </Button>
        </header>

        <label htmlFor="first-message" className="sr-only">
          What should Pi do?
        </label>
        <textarea
          ref={message}
          id="first-message"
          rows={4}
          value={text}
          placeholder="What should Pi do? Leave it empty to start idle."
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            const forced = event.metaKey || event.ctrlKey;

            if (
              isComposing(event) ||
              event.key !== "Enter" ||
              event.shiftKey ||
              (!forced && matchMedia("(pointer: coarse)").matches)
            ) {
              return;
            }

            event.preventDefault();
            submit();
          }}
          className="max-h-80 min-h-24 resize-none field-sizing-content bg-transparent px-5 py-2 text-prose text-fg placeholder:text-fg-dim focus:outline-none"
        />

        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
          <Picker
            label="Folder or repository"
            options={offered}
            selected={choices.where}
            multiple
            onSearch={search}
            placeholder="Search, or paste a path or repository URL"
            create={(query) => ({
              value: query,
              label: `Use ${query}`,
              detail: isRepository(query) ? "clone" : "folder",
            })}
            footer={
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={choices.share}
                  onChange={(event) => {
                    choose({ share: event.target.checked });
                  }}
                />
                Share the folder instead of a worktree of it
              </label>
            }
            onChange={(where) => {
              choose({ where });
            }}
          >
            {choices.where.length === 0 ? (
              <span className="text-fg-dim">Pick a folder or repository</span>
            ) : (
              choices.where.map(lastSegment).join(", ")
            )}
          </Picker>

          {!sharing && (
            <Picker
              label="Start from"
              options={[{ value: "", label: "Current branch" }]}
              selected={[startPoint]}
              placeholder="Branch, tag or commit"
              create={(query) => ({ value: query, label: query })}
              onChange={([value]) => {
                setStartPoint(value ?? "");
              }}
            >
              <span className="text-fg-dim">from </span>
              {startPoint === "" ? "current branch" : startPoint}
            </Picker>
          )}

          {environments.length > 1 && (
            <Picker
              label="Environment"
              options={environments.map((environment) => ({
                value: environment.id,
                label: environment.name,
                detail: availability(environment).toLowerCase(),
              }))}
              selected={chosen ? [chosen.id] : []}
              onChange={([environment]) => {
                choose({ environment: environment ?? "", model: "" });
              }}
            >
              <span className="text-fg-dim">on </span>
              {chosen?.name}
            </Picker>
          )}

          <Picker
            label="Model"
            options={[
              { value: "", label: "Environment default" },
              ...modelChoices,
            ]}
            {...(openGroups && { openGroups })}
            selected={[choices.model]}
            placeholder="Search models"
            create={(query) =>
              modelRef(query) === undefined
                ? undefined
                : { value: query, label: `Use ${query}` }
            }
            footer={
              <Slider
                label="Reasoning"
                stops={(["", ...thinkingLevels] as const).map((level) => ({
                  value: level,
                  label: level === "" ? "default" : level,
                }))}
                value={choices.thinking}
                onChange={(level) => {
                  choose({ thinking: level });
                }}
              />
            }
            onChange={([model]) => {
              if (model !== undefined && model !== "") {
                rememberModel(model);
              }

              choose({ model: model ?? "" });
            }}
          >
            {choices.model === "" ? "Default model" : choices.model}
            {choices.thinking !== "" && ` · ${choices.thinking}`}
          </Picker>

          {profiles.length > 1 && (
            <Picker
              label="Profile"
              options={profiles.map(({ id, name, isDefault }) => ({
                value: id,
                label: name,
                ...(isDefault && { detail: "default" }),
              }))}
              selected={profile ? [profile.id] : []}
              onChange={([id]) => {
                choose({ profile: id ?? "" });
              }}
            >
              {profile?.name}
            </Picker>
          )}

          <Button
            variant="primary"
            type="submit"
            disabled={submitting}
            className="ml-auto"
          >
            Start session
          </Button>
        </div>

        {error !== undefined && (
          <p
            role="alert"
            className="border-t border-line px-5 py-2 text-caption text-failed"
          >
            {error}
          </p>
        )}
      </form>
    </dialog>
  );
}
