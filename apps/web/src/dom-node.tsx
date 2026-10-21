import { type ReactElement, useLayoutEffect, useRef } from "react";

// Shows an element built outside React, like a prompt form or a plugin part.
export function DomNode({
  node,
  className,
}: {
  readonly node: HTMLElement;
  readonly className?: string;
}): ReactElement {
  const host = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    host.current?.replaceChildren(node);
  }, [node]);

  return <div ref={host} className={className} />;
}
