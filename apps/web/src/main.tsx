import { createRoot } from "react-dom/client";
import { App } from "./app";
import { loadPlugins, navEntries } from "./plugins";
import { applyTheme } from "./theme";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

applyTheme();

loadPlugins()
  .catch(() => undefined)
  .finally(() => {
    createRoot(root).render(<App nav={navEntries()} />);
  });
