import type {
  MountedSession,
  SessionPartProps,
  WebPlugin,
} from "@pi-cloud/plugins/web";
import { Button, cn, Icon } from "@pi-cloud/ui";
import { type ReactElement, useEffect, useState } from "react";
import type { CheckoutChanges, PullRequest } from "../src/report";
import { type DiffFile, type DiffLine, parseDiff } from "./diff";

export const changes: WebPlugin = {
  name: "changes",
  SessionPanel,
};

function SessionPanel({ session }: SessionPartProps): ReactElement {
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

  return (
    <>
      {found
        .filter(({ files }) => files.length > 0)
        .map((checkout) => (
          <Checkout
            key={checkout.name}
            checkout={checkout}
            session={session}
            pullRequest={pullRequests.find(
              ({ name }) => name === checkout.name,
            )}
          />
        ))}
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

  return (
    <div className="relative">
      <details className="group/changes">
        <summary className="flex min-h-control cursor-pointer list-none items-center gap-1.5 text-label text-fg-dim hover:text-fg [&::-webkit-details-marker]:hidden">
          <Icon
            name="chevron-right"
            className="size-3.5 transition-transform group-open/changes:rotate-90"
          />
          {`${name === "" ? "Changes" : `Changes in ${name}`} (${String(files.length)} ${files.length === 1 ? "file" : "files"})`}
          {!truncated && (
            <span className="font-mono text-mono-sm">
              <span className="text-done">+{added}</span>{" "}
              <span className="text-failed">−{removed}</span>
            </span>
          )}
        </summary>
        <div className="mt-2 flex max-h-[50vh] flex-col gap-2 overflow-auto">
          {truncated ? (
            <p className="text-fg-dim">The patch is too large to show.</p>
          ) : (
            diff.map((file) => <FileDiff key={file.path} file={file} />)
          )}
        </div>
      </details>
      {branched && (
        <PullRequestActions
          name={name}
          session={session}
          pullRequest={pullRequest}
        />
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
    <div className="absolute top-0 right-0 flex flex-col items-end gap-1">
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
        if (event.key === "Escape") {
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

function FileDiff({ file }: { readonly file: DiffFile }): ReactElement {
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
        {file.hunks.map((hunk) => (
          <tbody key={hunk.header}>
            <tr>
              <td
                colSpan={4}
                className="bg-accent-tint px-3 py-0.5 text-fg-dim"
              >
                {hunk.header}
              </td>
            </tr>
            {hunk.lines.map((line, index) => (
              <tr
                key={`${String(index)}-${line.kind}`}
                className={lineStyles[line.kind]}
              >
                <td className="w-10 px-2 text-right text-fg-dim select-none">
                  {line.oldLine}
                </td>
                <td className="w-10 px-2 text-right text-fg-dim select-none">
                  {line.newLine}
                </td>
                <td className="w-4 text-fg-dim select-none">
                  {marks[line.kind]}
                </td>
                <td className="pr-3 whitespace-pre-wrap">{line.text}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </details>
  );
}
