import type { SessionPartProps, WebPlugin } from "@pi-cloud/plugins/web";
import { Icon } from "@pi-cloud/ui";
import { type ReactElement, useEffect, useState } from "react";
import type { CheckoutChanges } from "../src/report";
import { type DiffFile, type DiffLine, parseDiff } from "./diff";

export const changes: WebPlugin = {
  name: "changes",
  SessionPanel,
};

function SessionPanel({ session }: SessionPartProps): ReactElement {
  const [found, setFound] = useState<readonly CheckoutChanges[]>([]);

  useEffect(
    () =>
      session.events((event) => {
        if (
          event.type === "live" &&
          event.event.type === "plugin" &&
          event.event.plugin === "changes"
        ) {
          setFound(event.event.data as readonly CheckoutChanges[]);
        }
      }),
    [session],
  );

  return (
    <>
      {found
        .filter(({ files }) => files.length > 0)
        .map((checkout) => (
          <Checkout key={checkout.name} checkout={checkout} />
        ))}
    </>
  );
}

function Checkout({
  checkout: { name, files, patch, truncated },
}: {
  readonly checkout: CheckoutChanges;
}): ReactElement {
  const diff = parseDiff(patch);
  const added = diff.reduce((sum, file) => sum + file.added, 0);
  const removed = diff.reduce((sum, file) => sum + file.removed, 0);

  return (
    <details className="group/changes">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-label text-fg-dim hover:text-fg [&::-webkit-details-marker]:hidden">
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
