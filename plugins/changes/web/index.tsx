import type {
  MountedSession,
  SessionPartProps,
  WebPlugin,
} from "@pi-cloud/plugins/web";
import { Button, cn, Icon, isComposing } from "@pi-cloud/ui";
import { Fragment, type ReactElement, useEffect, useState } from "react";
import type { CheckoutChanges, PullRequest } from "../src/report";
import { type DiffComment, reviewMessage } from "./comments";
import { type DiffFile, type DiffLine, parseDiff } from "./diff";

export const changes: WebPlugin = {
  name: "changes",
  SessionHeader,
};

// The header's Diff button opens the session's changes in a side panel, like
// the mockups and Claude Code's diff view.
function SessionHeader({ session }: SessionPartProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<readonly CheckoutChanges[]>([]);
  const [pullRequests, setPullRequests] = useState<readonly PullRequest[]>([]);

  useEffect(
    () =>
      session.events((event) => {
        if (
          event.type !== "live" ||
          event.event.type !== "plugin" ||
          event.event.plugin !== "changes"
        ) {
          return;
        }

        if (event.event.key === "changes") {
          setFound(event.event.data as readonly CheckoutChanges[]);
        }

        if (event.event.key === "pull-requests") {
          setPullRequests(event.event.data as readonly PullRequest[]);
        }
      }),
    [session],
  );

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("keydown", close);

    return () => {
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const changed = found.filter(({ files }) => files.length > 0);
  if (changed.length === 0) {
    return null;
  }

  const count = changed.reduce((sum, { files }) => sum + files.length, 0);

  return (
    <>
      <Button
        variant="ghost"
        aria-expanded={open}
        aria-label={`Diff, ${String(count)} ${count === 1 ? "file" : "files"} changed`}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="git-pull-request" className="size-3.5" />
        Diff
      </Button>
      <section
        role="dialog"
        aria-label="Changes"
        hidden={!open}
        className="fixed inset-y-0 right-0 z-40 flex w-[min(760px,100vw)] flex-col border-l border-line bg-panel text-ui text-fg shadow-pop"
      >
        <header className="flex min-h-14 items-center gap-2 border-b border-line px-4">
          <h2 className="flex-1 font-semibold text-fg-strong">Changes</h2>
          <Button
            variant="ghost"
            iconOnly
            aria-label="Close changes"
            onClick={() => {
              setOpen(false);
            }}
          >
            <Icon name="x" />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-4">
          {changed.map((checkout) => (
            <Checkout
              key={checkout.name}
              checkout={checkout}
              session={session}
              pullRequest={pullRequests.find(
                ({ name }) => name === checkout.name,
              )}
            />
          ))}
        </div>
      </section>
    </>
  );
}

function Checkout({
  checkout: { name, files, patch, truncated, branched },
  session,
  pullRequest,
}: {
  readonly checkout: CheckoutChanges;
  readonly session: MountedSession;
  readonly pullRequest: PullRequest | undefined;
}): ReactElement {
  const diff = parseDiff(patch);
  const added = diff.reduce((sum, file) => sum + file.added, 0);
  const removed = diff.reduce((sum, file) => sum + file.removed, 0);
  const [comments, setComments] = useState<readonly DiffComment[]>([]);
  const [sendError, setSendError] = useState<string>();

  const review: Review = {
    comments,
    add: (path, line, removedLine, text) => {
      setComments((current) => [
        ...current,
        { checkout: name, path, line, removed: removedLine, text },
      ]);
    },
    remove: (comment) => {
      setComments((current) => current.filter((c) => c !== comment));
    },
  };

  const send = (): void => {
    setSendError(undefined);

    session.send(reviewMessage(comments)).then(
      () => {
        setComments([]);
      },
      (error: unknown) => {
        setSendError(error instanceof Error ? error.message : String(error));
      },
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2">
        <h3 className="flex min-h-control flex-1 items-center gap-1.5 text-label text-fg-dim">
          {`${name === "" ? "Changes" : `Changes in ${name}`} (${String(files.length)} ${files.length === 1 ? "file" : "files"})`}
          {!truncated && (
            <span className="font-mono text-mono-sm">
              <span className="text-done">+{added}</span>{" "}
              <span className="text-failed">−{removed}</span>
            </span>
          )}
        </h3>
        {branched && (
          <PullRequestActions
            name={name}
            session={session}
            pullRequest={pullRequest}
          />
        )}
      </div>
      {truncated ? (
        <p className="text-fg-dim">The patch is too large to show.</p>
      ) : (
        diff.map((file) => (
          <FileDiff key={file.path} file={file} review={review} />
        ))
      )}
      {comments.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-label text-fg-dim">
          {`${String(comments.length)} ${comments.length === 1 ? "comment" : "comments"} on the diff`}
          <Button variant="primary" onClick={send}>
            Send to Pi
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setComments([]);
            }}
          >
            Discard
          </Button>
          {sendError !== undefined && (
            <span role="alert" className="text-failed">
              {sendError}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const modes = [
  { command: "", label: "Create PR" },
  { command: "draft", label: "Create draft PR" },
  { command: "compose", label: "Compose on GitHub" },
] as const;

// The Create PR button runs the session part's /pr command (ADR 0021).
function PullRequestActions({
  name,
  session,
  pullRequest,
}: {
  readonly name: string;
  readonly session: MountedSession;
  readonly pullRequest: PullRequest | undefined;
}): ReactElement {
  const [sendError, setSendError] = useState<string>();

  const run = (mode: string): void => {
    setSendError(undefined);

    session
      .send(["/pr", mode, name].filter((part) => part !== "").join(" "))
      .catch((error: unknown) => {
        setSendError(error instanceof Error ? error.message : String(error));
      });
  };

  const problem =
    sendError ??
    (pullRequest?.status === "failed" ? pullRequest.error : undefined) ??
    (pullRequest?.status === "compose" ? pullRequest.reason : undefined);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {pullRequest?.status === "open" && (
          <>
            <Button
              onClick={() => {
                run("");
              }}
            >
              Push
            </Button>
            <ExternalLink href={pullRequest.url}>View PR</ExternalLink>
          </>
        )}
        {pullRequest?.status === "compose" && (
          <ExternalLink href={pullRequest.url}>Open on GitHub</ExternalLink>
        )}
        {pullRequest?.status === "pushed" && (
          <span className="text-label text-fg-dim">
            Pushed {pullRequest.branch}
          </span>
        )}
        {pullRequest?.status === "working" ? (
          <Button disabled>
            <Icon name="git-pull-request" className="size-3.5" />
            Creating PR…
          </Button>
        ) : (
          pullRequest?.status !== "open" && <CreateMenu run={run} />
        )}
      </div>
      {problem !== undefined && problem !== null && (
        <p role="alert" className="max-w-80 text-right text-label text-failed">
          {problem}
        </p>
      )}
    </div>
  );
}

function CreateMenu({
  run,
}: {
  readonly run: (mode: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="relative flex"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <Button
        variant="primary"
        className="rounded-r-none"
        onClick={() => {
          run("");
        }}
      >
        <Icon name="git-pull-request" className="size-3.5" />
        Create PR
      </Button>
      <Button
        variant="primary"
        iconOnly
        aria-label="More ways to create a PR"
        aria-expanded={open}
        aria-haspopup="menu"
        className="rounded-l-none border-l-on-accent/30"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="chevron-down" className="size-3.5" />
      </Button>
      {open && (
        <ul
          role="menu"
          className="absolute top-full right-0 z-10 mt-1 w-48 rounded-lg border border-line bg-panel p-1 shadow-card"
        >
          {modes.map(({ command, label }) => (
            <li key={command} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  run(command);
                }}
                className="w-full cursor-pointer rounded-md px-3 py-1.5 text-left text-ui text-fg hover:bg-hover"
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExternalLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: string;
}): ReactElement {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex h-control items-center gap-1 rounded-md border border-line bg-elevated px-3 text-ui font-medium text-fg hover:border-line-strong hover:bg-hover",
      )}
    >
      {children}
      <Icon name="external-link" className="size-3.5" />
    </a>
  );
}

const lineStyles: Readonly<Record<DiffLine["kind"], string>> = {
  add: "bg-done-tint",
  remove: "bg-failed-tint",
  context: "",
  note: "text-fg-dim italic",
};

const marks: Readonly<Record<DiffLine["kind"], string>> = {
  add: "+",
  remove: "−",
  context: " ",
  note: " ",
};

interface Review {
  readonly comments: readonly DiffComment[];
  readonly add: (
    path: string,
    line: number,
    removed: boolean,
    text: string,
  ) => void;
  readonly remove: (comment: DiffComment) => void;
}

function FileDiff({
  file,
  review,
}: {
  readonly file: DiffFile;
  readonly review: Review;
}): ReactElement {
  const [drafting, setDrafting] = useState<string>();
  const comments = review.comments.filter(({ path }) => path === file.path);

  return (
    <details open className="rounded-md border border-line bg-code">
      <summary className="sticky top-0 flex cursor-pointer items-center justify-between gap-3 rounded-t-md border-b border-line bg-elevated px-3 py-1.5 font-mono text-mono-sm text-fg">
        <span className="truncate">{file.path}</span>
        <span className="shrink-0">
          <span className="text-done">+{file.added}</span>{" "}
          <span className="text-failed">−{file.removed}</span>
        </span>
      </summary>
      <table className="w-full border-collapse font-mono text-mono-sm">
        {file.hunks.map((hunk, hunkIndex) => (
          <tbody key={hunk.header}>
            <tr>
              <td
                colSpan={4}
                className="bg-accent-tint px-3 py-0.5 text-fg-dim"
              >
                {hunk.header}
              </td>
            </tr>
            {hunk.lines.map((line, index) => {
              const at = line.newLine ?? line.oldLine;
              const removed = line.kind === "remove";
              const row = `${String(hunkIndex)}-${String(index)}`;
              const where = `${file.path} ${removed ? "removed " : ""}line ${String(at)}`;

              return (
                <Fragment key={`${String(index)}-${line.kind}`}>
                  <tr className={cn("group/line", lineStyles[line.kind])}>
                    <td className="w-10 px-2 text-right text-fg-dim select-none">
                      {line.oldLine}
                    </td>
                    <td className="w-10 px-2 text-right text-fg-dim select-none">
                      {line.newLine}
                    </td>
                    <td className="w-5 text-fg-dim select-none">
                      {at === undefined || line.kind === "note" ? (
                        marks[line.kind]
                      ) : (
                        <button
                          type="button"
                          aria-label={`Comment on ${where}`}
                          onClick={() => {
                            setDrafting(row);
                          }}
                          className="flex size-4 cursor-pointer items-center justify-center rounded-sm text-fg-dim opacity-0 group-hover/line:bg-accent group-hover/line:text-on-accent group-hover/line:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                        >
                          <Icon name="plus" className="size-3" />
                        </button>
                      )}
                    </td>
                    <td className="pr-3 whitespace-pre-wrap">{line.text}</td>
                  </tr>
                  {comments
                    .filter(
                      (comment) =>
                        comment.line === at && comment.removed === removed,
                    )
                    .map((comment, number) => (
                      <tr key={`comment-${String(number)}`}>
                        <td colSpan={4} className="px-3 py-1.5">
                          <div className="flex items-start gap-2 rounded-md border border-line bg-elevated px-3 py-2 font-sans text-ui text-fg">
                            <span className="flex-1 whitespace-pre-wrap">
                              {comment.text}
                            </span>
                            <button
                              type="button"
                              aria-label={`Delete comment on ${where}`}
                              onClick={() => {
                                review.remove(comment);
                              }}
                              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-dim hover:bg-hover hover:text-fg"
                            >
                              <Icon name="x" className="size-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  {at !== undefined && drafting === row && (
                    <tr>
                      <td colSpan={4} className="px-3 py-1.5">
                        <CommentForm
                          label={`Comment on ${where}`}
                          onSave={(text) => {
                            review.add(file.path, at, removed, text);
                            setDrafting(undefined);
                          }}
                          onCancel={() => {
                            setDrafting(undefined);
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        ))}
      </table>
    </details>
  );
}

function CommentForm({
  label,
  onSave,
  onCancel,
}: {
  readonly label: string;
  readonly onSave: (text: string) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const [text, setText] = useState("");

  const save = (): void => {
    if (text.trim() !== "") {
      onSave(text);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      className="flex flex-col gap-2 rounded-md border border-accent bg-elevated p-2 font-sans"
    >
      <textarea
        aria-label={label}
        autoFocus
        rows={2}
        value={text}
        placeholder="Leave a comment for Pi"
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !isComposing(event)) {
            event.preventDefault();
            save();
          }

          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
        className="resize-none bg-transparent text-ui text-fg placeholder:text-fg-dim focus:outline-none"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={text.trim() === ""}>
          Add comment
        </Button>
      </div>
    </form>
  );
}
