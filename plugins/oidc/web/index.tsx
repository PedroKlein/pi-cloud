import {
  json,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pi-cloud/plugins/web";
import { Button, Section } from "@pi-cloud/ui";
import type { ReactElement } from "react";
import type { LinkedIdentity } from "../src/identity";

interface Identities {
  readonly configured: boolean;
  readonly identities: readonly LinkedIdentity[];
}

export const oidc: WebPlugin = {
  name: "oidc",
  SettingsSection,
};

function SettingsSection({
  context,
}: {
  readonly context: WebContext;
}): ReactElement | null {
  const { value, reload } = useLoaded(
    async () => json<Identities>(context.request("identities")),
    "identities",
  );

  if (value?.configured !== true) {
    return null;
  }

  const linked = value.identities[0];

  return (
    <Section title="Single sign-on">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-5 text-ui">
        {linked === undefined ? (
          <>
            <p className="flex-1 text-fg-dim">
              Link your identity provider account to sign in with it.
            </p>
            <Button
              onClick={() => {
                location.assign("/api/plugins/oidc/link");
              }}
            >
              Link account
            </Button>
          </>
        ) : (
          <>
            <p className="flex-1 text-fg">
              You sign in as {linked.email ?? "your linked account"}.
            </p>
            {!linked.created && (
              <Button
                onClick={() => {
                  void json(context.request("unlink", {})).then(reload, reload);
                }}
              >
                Unlink
              </Button>
            )}
          </>
        )}
      </div>
    </Section>
  );
}
