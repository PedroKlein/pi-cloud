import { createRoot } from "react-dom/client";
import { App } from "./app";
import { loadPlugins, navEntries } from "./plugins";
import { type Login, SignInPage } from "./sign-in";
import { applyTheme } from "./theme";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

applyTheme();

const status = await fetch("/api/auth")
  .then(
    async (response) =>
      (await response.json()) as {
        readonly user: { readonly name: string } | null;
        readonly setup: boolean;
        readonly logins: readonly Login[];
        readonly passwordLogin: boolean;
      },
  )
  .catch(() => undefined);

const setupToken = /^#setup\/(.+)$/.exec(location.hash)?.[1];

if (status === undefined) {
  root.textContent = "The server can't be reached. Reload to try again.";
} else if (status.user === null) {
  createRoot(root).render(
    <SignInPage
      setup={status.setup}
      setupToken={setupToken}
      logins={status.logins}
      passwordLogin={status.passwordLogin}
    />,
  );
} else {
  await loadPlugins().catch(() => undefined);
  createRoot(root).render(<App nav={navEntries()} user={status.user.name} />);
}
