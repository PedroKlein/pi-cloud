import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionPlugin } from "@pi-cloud/plugins";
import type { SessionStart } from "@pi-cloud/protocol";
import { fetchSessionPart } from "./client";

// Loads an installed plugin's Session part, fetching its bundle into the
// Session's folder the first time, so a reload doesn't fetch it again.
export function installedSessionParts(
  server: string,
  assignment: SessionStart,
  sessionDir: string,
): (name: string, hash: string) => Promise<SessionPlugin> {
  const dir = join(sessionDir, "plugin-parts");

  return async (name, hash) => {
    const path = join(dir, `${name}-${hash}.js`);

    if (!(await exists(path))) {
      const code = await fetchSessionPart(server, assignment, name, hash);
      const got = new Bun.CryptoHasher("sha256").update(code).digest("hex");

      if (got !== hash) {
        throw new Error(`the ${name} plugin's Session part changed on the way`);
      }

      // Two starts of one Session can fetch it at once.
      const partial = `${path}.${randomUUID()}`;

      await mkdir(dir, { recursive: true });
      await writeFile(partial, code);
      await rename(partial, path);
    }

    const { default: plugin } = (await import(path)) as {
      default?: SessionPlugin;
    };

    if (plugin?.name !== name) {
      throw new Error(
        `the ${name} plugin's Session part must export as default a Session part named ${name}`,
      );
    }

    return plugin;
  };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
