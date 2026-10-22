import { join } from "node:path";
import type { HostOptions } from "../host";

export function sessionOptions(
  root: string,
  overrides: Partial<HostOptions> = {},
): HostOptions {
  return {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    extensionPaths: [],
    ...overrides,
  };
}
