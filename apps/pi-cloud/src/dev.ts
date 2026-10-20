import { type ChildProcess, spawn } from "node:child_process";
import { watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stderrLog } from "./log";

const log = stderrLog("dev");
const main = join(import.meta.dirname, "main.ts");
const repo = join(import.meta.dirname, "..", "..", "..");
const dataRoot = join(homedir(), ".pi-cloud", "dev");

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
  ["agent", "--name", "local", "--data-dir", join(dataRoot, "agent")],
];

let children: ChildProcess[] = [];
let restart: ReturnType<typeof setTimeout> | undefined;

function start(): void {
  children = commands.map((args) =>
    spawn(process.execPath, [main, ...args], { stdio: "inherit" }),
  );
}

async function stop(): Promise<void> {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }),
  );
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
      void stop().then(start);
    }, 200);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearTimeout(restart);
    void stop().then(() => process.exit(0));
  });
}

log("starting server and agent", {
  providers: ["cloud", "local"],
  dataRoot,
});

start();
