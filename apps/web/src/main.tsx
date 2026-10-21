import { createRoot } from "react-dom/client";
import { App } from "./app";
import { loadPlugins, navEntries } from "./plugins";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

loadPlugins()
  .catch(() => undefined)
  .finally(() => {
    createRoot(root).render(<App nav={navEntries()} />);
  });
