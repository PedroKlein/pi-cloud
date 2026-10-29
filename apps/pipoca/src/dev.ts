import { watch } from "node:fs";
import { join } from "node:path";
import { dataFolder } from "./data-folder";
import { stderrLog } from "./log";
import { supervise, type Supervisor } from "./restart";

const log = stderrLog("dev");
const main = join(import.meta.dirname, "main.ts");
const repo = join(import.meta.dirname, "..", "..", "..");
const dataRoot = join(dataFolder(), "dev");

const commands = [
  [
    "server",
    "--database",
    join(dataRoot, "server.db"),
    "--provider",
    "cloud",
    "--data-dir",
    join(dataRoot, "server"),
  ],
  [
    "agent",
    "--name",
    "local",
    "--data-dir",
    join(dataRoot, "agent"),
    "--folder",
    repo,
  ],
];

let children: Supervisor[] = [];
let restart: ReturnType<typeof setTimeout> | undefined;
let restarting: Promise<void> = Promise.resolve();
let exiting = false;

function start(): void {
  children = commands.map((args) =>
    supervise([process.execPath, main, ...args], log),
  );
}

async function stop(): Promise<void> {
  await Promise.all(children.map(async (child) => child.stop()));
}

// Restart child processes instead of using bun --watch, which does not
// restart once Pi is loaded in the same process.
for (const dir of ["apps", "packages"]) {
  watch(join(repo, dir), { recursive: true }, (_event, file) => {
    if (file === null || /node_modules|dist\//.test(file)) {
      return;
    }

    clearTimeout(restart);

    restart = setTimeout(() => {
      log("restarting", { changed: join(dir, file) });

      restarting = restarting.then(stop).then(() => {
        if (!exiting) {
          start();
        }
      });
    }, 200);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    exiting = true;
    clearTimeout(restart);
    void restarting.then(stop).then(() => process.exit(0));
  });
}

log("starting server and agent", {
  providers: ["cloud", "local"],
  dataRoot,
});

start();
