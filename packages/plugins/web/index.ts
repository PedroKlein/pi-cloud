import type { SessionEvent } from "@pi-cloud/protocol";

export interface WebContext {
  // Requests go to the plugin's own routes under /api/plugins/<name>/.
  readonly request: (path: string, body?: unknown) => Promise<Response>;
  readonly sessionEvents: (
    sessionId: string,
    listener: (event: SessionEvent) => void,
  ) => () => void;
  readonly openSession: (sessionId: string) => void;
}

export type Unmount = () => void;

export interface MountedSession {
  readonly id: string;
  // Every event the Session view receives, from the start of its stream.
  readonly events: (listener: (event: SessionEvent) => void) => () => void;
}

export type PageMount = (element: HTMLElement, context: WebContext) => Unmount;

export type SessionMount = (
  element: HTMLElement,
  context: WebContext,
  session: MountedSession,
) => Unmount;

export interface WebPlugin {
  readonly name: string;
  readonly nav?: { readonly label: string; readonly mount: PageMount };
  readonly sessionPanel?: SessionMount;
  readonly sessionHeader?: SessionMount;
}
