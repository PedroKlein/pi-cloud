import { join } from "node:path";
import type { HostOptions } from "../host";

export function sessionOptions(
  root: string,
  overrides: Partial<HostOptions> = {},
): HostOptions {
  return {
    cwd: root,
    agentDir: join(root, "agent"),
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
    sessionDir: join(root, "sessions"),
    extensionPaths: [],
    ...overrides,
  };
}
