import { createRoot } from "react-dom/client";
import { App } from "./app";
import { loadPlugins, navEntries } from "./plugins";
import { SignInPage } from "./sign-in";
import { applyTheme } from "./theme";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

applyTheme();

const status = (await (await fetch("/api/auth")).json()) as {
  readonly user: unknown;
  readonly setup: boolean;
};

const setupToken = /^#setup\/(.+)$/.exec(location.hash)?.[1];

if (status.user === null) {
  createRoot(root).render(
    <SignInPage setupToken={status.setup ? setupToken : undefined} />,
  );
} else {
  await loadPlugins().catch(() => undefined);
  createRoot(root).render(<App nav={navEntries()} />);
}
