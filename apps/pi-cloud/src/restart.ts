// The server exits with this when it restarts, and whatever runs it starts it
// again: systemd's Restart=on-failure, a pod's restart policy, or the dev
// loop (ADR 0022).
export const restartExitCode = 75;

// Whether something starts the server again when it exits. systemd sets
// INVOCATION_ID, Kubernetes sets KUBERNETES_SERVICE_HOST, and the dev loop
// sets PI_CLOUD_SUPERVISED.
export function supervised(env: NodeJS.ProcessEnv): boolean {
  return [
    "INVOCATION_ID",
    "KUBERNETES_SERVICE_HOST",
    "PI_CLOUD_SUPERVISED",
  ].some((name) => env[name] !== undefined);
}
