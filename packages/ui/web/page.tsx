import type { ReactElement, ReactNode } from "react";

export function PageTitle({
  children,
  description,
}: {
  readonly children: ReactNode;
  readonly description?: ReactNode;
}): ReactElement {
  return (
    <header className="mb-6 flex flex-col gap-2">
      <h1 className="text-display font-semibold text-fg-strong">{children}</h1>
      {description !== undefined && (
        <p className="max-w-chat text-ui text-fg-dim">{description}</p>
      )}
    </header>
  );
}

export function Section({
  title,
  children,
}: {
  readonly title: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="mt-8 flex flex-col gap-3">
      <h2 className="text-title font-semibold text-fg-strong">{title}</h2>
      {children}
    </section>
  );
}
