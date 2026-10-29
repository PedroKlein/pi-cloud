import {
  json,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pipoca/plugins/web";
import { Button, Section } from "@pipoca/ui";
import type { ReactElement } from "react";
import type { Account } from "../src/model";

export const logins: WebPlugin = {
  name: "logins",
  SettingsSection,
};

const typeLabels = { oauth: "account", api_key: "API key" } as const;

function SettingsSection({
  context,
}: {
  readonly context: WebContext;
}): ReactElement | null {
  const { value, reload } = useLoaded(
    async () => json<Account>(context.request("account")),
    "account",
    { topics: ["logins.logins"] },
  );

  if (value === undefined) {
    return null;
  }

  return (
    <Section title="Model logins">
      <p className="text-ui text-fg-dim">
        Your Sessions use these logins on every runner. Log in to a provider
        with /login in any Session.
      </p>
      <ul
        aria-label="Your model logins"
        className="flex flex-col gap-2 rounded-lg border border-line bg-elevated shadow-xs p-3 text-ui"
      >
        {value.logins.length === 0 && (
          <li className="text-fg-dim">You haven't logged in to any yet.</li>
        )}
        {value.logins.map((login) => (
          <li key={login.provider} className="flex items-center gap-2">
            <span className="flex-1 truncate text-fg">
              {login.provider}
              <span className="text-fg-dim">
                {` · ${typeLabels[login.type]}`}
              </span>
            </span>
            <Button
              aria-label={`Log out of ${login.provider}`}
              onClick={() => {
                void json(
                  context.request("remove", {
                    method: "POST",
                    body: JSON.stringify({ provider: login.provider }),
                  }),
                ).then(reload, reload);
              }}
            >
              Log out
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
