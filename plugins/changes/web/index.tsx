import type { SessionPartProps, WebPlugin } from "@pi-cloud/plugins/web";
import { Icon } from "@pi-cloud/ui";
import { type ReactElement, useEffect, useState } from "react";
import type { CheckoutChanges } from "../src/report";

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
  checkout: { name, files, stat, patch, truncated },
}: {
  readonly checkout: CheckoutChanges;
}): ReactElement {
  return (
    <details className="group/changes">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-label text-fg-dim hover:text-fg [&::-webkit-details-marker]:hidden">
        <Icon
          name="chevron-right"
          className="size-3.5 transition-transform group-open/changes:rotate-90"
        />
        {`${name === "" ? "Changes" : `Changes in ${name}`} (${String(files.length)} files)`}
      </summary>
      <pre className="mt-2 max-h-[40vh] overflow-auto rounded-md bg-code px-3 py-2 font-mono text-mono-sm">
        {stat}
      </pre>
      <pre className="mt-2 max-h-[40vh] overflow-auto rounded-md bg-code px-3 py-2 font-mono text-mono-sm">
        {truncated ? "The patch is too large to show." : patch}
      </pre>
    </details>
  );
}
