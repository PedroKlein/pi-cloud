import type { EmbeddedSessionProps } from "@pi-cloud/plugins/web";
import { createContext, type ReactElement, useContext } from "react";
import { useEnvironments } from "./hooks";
import { SessionView } from "./session-view";

// Opens the sessions drawer on a phone, for a page that fills the window.
export const ShellMenu = createContext<(() => void) | undefined>(undefined);

export function EmbeddedSession(props: EmbeddedSessionProps): ReactElement {
  const environments = useEnvironments();
  const onMenu = useContext(ShellMenu);

  return (
    <SessionView
      key={props.sessionId}
      {...props}
      environments={environments.value}
      {...(props.layout === "full" && onMenu && { onMenu })}
    />
  );
}
