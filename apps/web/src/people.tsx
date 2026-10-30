import { availability, type Environment, type Session } from "@pipoca/protocol";
import { Badge, Button, PageTitle, Section } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { api, command } from "./api";
import { deleteEnvironment } from "./environments";
import {
  type Person,
  useEveryonesEnvironments,
  useEveryonesSessions,
  usePeople,
} from "./hooks";

const busy = new Set(["queued", "starting", "running"]);

// What an admin sees of everyone's work: names and states, never
// transcripts, files or variable values (ADR 0049).
export function PeoplePage(): ReactElement {
  const people = usePeople();
  const environments = useEveryonesEnvironments();
  const sessions = useEveryonesSessions();
  const [error, setError] = useState<string>();

  const act = (run: Promise<unknown>): void => {
    run.then(
      () => {
        setError(undefined);
        sessions.reload();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  const personOf = (session: Session): string | null =>
    session.startedBy ??
    environments.value.find(({ id }) => id === session.environmentId)
      ?.ownerId ??
    null;

  return (
    <div className="mx-auto flex w-full max-w-form flex-col px-4 py-10 md:px-10">
      <PageTitle description="Everyone's Environments and running Sessions, as admins see them: names and states, never transcripts, files or variable values. Admins can stop or archive a Session, and delete an Environment once its Sessions are archived.">
        People
      </PageTitle>
      {error !== undefined && (
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      )}
      {people.value.map((person) => (
        <PersonSection
          key={person.id}
          person={person}
          environments={environments.value.filter(
            ({ ownerId }) => ownerId === person.id,
          )}
          sessions={sessions.value.filter(
            (session) => personOf(session) === person.id,
          )}
          onStop={(session) => {
            act(command(session.id, { type: "abort" }));
          }}
          onDelete={(environment) => {
            act(deleteEnvironment(environment).then(environments.reload));
          }}
          onArchive={(session) => {
            act(
              api(
                `/api/sessions/${encodeURIComponent(session.id)}/archive`,
                {},
              ),
            );
          }}
        />
      ))}
    </div>
  );
}

function PersonSection({
  person,
  environments,
  sessions,
  onStop,
  onArchive,
  onDelete,
}: {
  readonly person: Person;
  readonly environments: readonly Environment[];
  readonly sessions: readonly Session[];
  readonly onStop: (session: Session) => void;
  readonly onArchive: (session: Session) => void;
  readonly onDelete: (environment: Environment) => void;
}): ReactElement {
  const environmentName = (id: string): string =>
    environments.find((each) => each.id === id)?.name ?? id;

  return (
    <Section title={person.admin ? `${person.name} (admin)` : person.name}>
      <div
        aria-label={person.name}
        className="flex flex-col gap-3 rounded-lg border border-line bg-elevated p-5 text-ui shadow-xs"
      >
        {environments.length === 0 ? (
          <p className="text-fg-dim">No Environments yet.</p>
        ) : (
          <ul aria-label="Environments" className="flex flex-wrap gap-2">
            {environments.map((environment) => (
              <li
                key={environment.id}
                className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5"
              >
                {environment.name}
                <Badge
                  state={
                    availability(environment) === "Offline" ? "offline" : "done"
                  }
                >
                  {availability(environment) === "Starts runners on demand"
                    ? "On demand"
                    : availability(environment)}
                </Badge>
                <Button
                  variant="ghost"
                  aria-label={`Delete ${environment.name}`}
                  onClick={() => {
                    onDelete(environment);
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
        {sessions.length === 0 ? (
          <p className="text-fg-dim">No active Sessions.</p>
        ) : (
          <ul
            aria-label="Sessions"
            className="flex flex-col divide-y divide-line"
          >
            {sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center gap-2 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-fg-strong">
                  {session.title ?? "Untitled Session"}
                </span>
                <span className="text-caption text-fg-dim">
                  {environmentName(session.environmentId)} · {session.status}
                </span>
                {busy.has(session.status) && (
                  <Button
                    onClick={() => {
                      onStop(session);
                    }}
                  >
                    Stop
                  </Button>
                )}
                <Button
                  onClick={() => {
                    onArchive(session);
                  }}
                >
                  Archive
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
