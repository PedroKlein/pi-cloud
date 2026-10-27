import { Button, Field, fieldClass } from "@pipoca/ui";
import {
  type ReactElement,
  type ReactNode,
  type SubmitEvent,
  useState,
} from "react";
import { api } from "./api";
import { Mark } from "./mark";

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
      <Welcome
        title="No users yet"
        description="Open the setup link from the server's log to create the first user."
      />
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
    <Welcome
      title={setupToken === undefined ? "Sign in" : "Create the first user"}
      {...(setupToken !== undefined && {
        description: "This user becomes the server's first admin.",
      })}
    >
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
          className="flex flex-col gap-4 rounded-lg border border-line bg-elevated p-6 shadow-card"
        >
          <Field label="Name">
            <input
              name="name"
              required
              autoComplete="username"
              className={fieldClass}
            />
          </Field>
          <Field
            label="Password"
            hint={
              setupToken === undefined ? undefined : "At least 8 characters."
            }
          >
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
          {error !== undefined && (
            <p role="alert" className="text-caption text-failed">
              {error}
            </p>
          )}
          <Button variant="primary" type="submit" className="h-10 w-full">
            {setupToken === undefined ? "Sign in" : "Create user"}
          </Button>
        </form>
      )}
    </Welcome>
  );
}

function Welcome({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm animate-rise-in flex-col justify-center px-4 py-16">
      <div className="mb-8 flex flex-col items-center gap-4 text-center">
        <span className="flex items-center gap-2 font-serif text-wordmark font-light text-fg-strong">
          <Mark className="size-8" />
          pipoca
        </span>
        <h1 className="font-serif text-display font-light text-fg-strong">
          {title}
        </h1>
        {description !== undefined && (
          <p className="text-label text-fg-dim">{description}</p>
        )}
      </div>
      {children}
    </main>
  );
}
