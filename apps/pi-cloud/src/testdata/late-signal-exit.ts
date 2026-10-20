import { cpSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Pi's dependencies can load a second copy of signal-exit after pi-cloud has
// installed its SIGTERM handler. Loading a fresh copy of the real package
// right after that handler appears reproduces it.
const require = createRequire(
  createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve(
    "proper-lockfile",
  ),
);

function loadSignalExitCopy(): void {
  const copy = mkdtempSync(join(tmpdir(), "signal-exit-"));
  cpSync(dirname(require.resolve("signal-exit")), copy, { recursive: true });

  (require(join(copy, "index.js")) as (callback: () => void) => void)(
    () => undefined,
  );

  process.stderr.write("signal-exit copy loaded\n");
}

const signalExitHandler = "processOk";

const watchHandlers = (event: string | symbol, listener: unknown): void => {
  if (event === "SIGTERM" && !String(listener).includes(signalExitHandler)) {
    process.removeListener("newListener", watchHandlers);
    setImmediate(loadSignalExitCopy);
  }
};

process.on("newListener", watchHandlers);
