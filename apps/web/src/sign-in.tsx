import { Button, Field, fieldClass, PageTitle } from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api } from "./api";

const messages: Record<string, string> = {
  wrong_password: "Wrong name or password.",
  locked: "Too many failed sign-ins. Try again in 15 minutes.",
  invalid_token:
    "This setup link is not the server's current one. Open the link from its latest log.",
};

// Another way in that a plugin offers, such as single sign-on (ADR 0038).
export interface Login {
  readonly label: string;
  readonly path: string;
}

// The first user comes from the one-time link in the server's log (ADR 0034).
export function SignInPage({
  setup,
  setupToken: linkToken,
  logins,
  passwordLogin,
}: {
  // No user exists yet.
  readonly setup: boolean;
  readonly setupToken: string | undefined;
  readonly logins: readonly Login[];
  readonly passwordLogin: boolean;
}): ReactElement {
  const [error, setError] = useState<string>();
  const setupToken = setup ? linkToken : undefined;

  if (setup && setupToken === undefined) {
    return (
      <main className="mx-auto flex w-full max-w-sm flex-col px-4 py-16">
        <PageTitle description="Open the setup link from the server's log to create the first user.">
          No users yet
        </PageTitle>
      </main>
    );
  }

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value : "";
    };

    const credentials = { name: text("name"), password: text("password") };

    void (async () => {
      try {
        await (setupToken === undefined
          ? api("/api/auth/login", credentials)
          : api("/api/auth/setup", { ...credentials, token: setupToken }));

        location.replace("/");
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "";
        setError(messages[message] ?? message);
      }
    })();
  };

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col px-4 py-16">
      <PageTitle>
        {setupToken === undefined ? "Sign in" : "Create the first user"}
      </PageTitle>
      {setupToken === undefined && logins.length > 0 && (
        <div className="mb-4 flex flex-col gap-2">
          {logins.map(({ label, path }) => (
            <Button
              key={path}
              variant="primary"
              onClick={() => {
                location.assign(path);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
      {(passwordLogin || setupToken !== undefined) && (
        <form
          onSubmit={submit}
          className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5"
        >
          <Field label="Name">
            <input
              name="name"
              required
              autoComplete="username"
              className={fieldClass}
            />
          </Field>
          <Field label="Password">
            <input
              name="password"
              type="password"
              required
              minLength={setupToken === undefined ? undefined : 8}
              autoComplete={
                setupToken === undefined ? "current-password" : "new-password"
              }
              className={fieldClass}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" type="submit">
              {setupToken === undefined ? "Sign in" : "Create user"}
            </Button>
            {error !== undefined && (
              <p role="alert" className="text-caption text-failed">
                {error}
              </p>
            )}
          </div>
        </form>
      )}
    </main>
  );
}
