// The server exits with this when it restarts, and whatever runs it starts it
// again: systemd's Restart=on-failure, a pod's restart policy, or the dev
// loop (ADR 0022).
export const restartExitCode = 75;

// Whether something starts the server again when it exits: systemd sets
// INVOCATION_ID, and the helm chart and the dev loop set PIPOCA_SUPERVISED.
// Both are taken out of the environment, so a server started inside a
// Session doesn't think it is supervised too.
export function supervised(env: NodeJS.ProcessEnv): boolean {
  const found =
    env["INVOCATION_ID"] !== undefined ||
    env["PIPOCA_SUPERVISED"] !== undefined;

  delete env["INVOCATION_ID"];
  delete env["PIPOCA_SUPERVISED"];

  return found;
}
