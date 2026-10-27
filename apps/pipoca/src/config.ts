import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PluginConfig } from "@pipoca/plugins";
import type { Log } from "@pipoca/providers";

// The config folder's pipoca.json, a key per plugin (ADR 0039). People edit
// it by hand and plugins through their UI, so it is read again whenever it
// changes on disk.
export function configFolder(
  dir: string,
  log: Log,
): (plugin: string) => PluginConfig {
  const file = join(dir, "pipoca.json");
  const oldFile = join(dir, "pi-cloud.json");

  // The product was called Pi Cloud before ADR 0042.
  if (!existsSync(file) && existsSync(oldFile)) {
    renameSync(oldFile, file);
    log("config file renamed", { from: oldFile, to: file });
  }

  let values: Readonly<Record<string, unknown>> = {};
  let version: string | undefined;
  let broken = false;

  const current = (): Readonly<Record<string, unknown>> => {
    const seen = versionOf(file);
    if (seen === version) {
      return values;
    }

    version = seen;

    if (seen === undefined) {
      values = {};
      broken = false;

      return values;
    }

    try {
      values = parsed(file);
      broken = false;
    } catch (error) {
      // Plugins keep the last values that read, until the file is fixed.
      broken = true;

      log("config file unreadable", {
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return values;
  };

  return (plugin) => ({
    dir: join(dir, plugin),
    get: () => {
      const all = current();

      return Object.hasOwn(all, plugin) ? all[plugin] : undefined;
    },
    set: (value) => {
      const others = Object.fromEntries(
        Object.entries(current()).filter(([key]) => key !== plugin),
      );

      if (broken) {
        throw new Error(`fix ${file} first: it isn't a JSON object`);
      }

      const next =
        value === undefined ? others : { ...others, [plugin]: value };

      // A rename replaces the file whole, so a crash never leaves half of it.
      mkdirSync(dir, { recursive: true });
      const written = `${file}.${String(process.pid)}.tmp`;
      writeFileSync(written, `${JSON.stringify(next, null, 2)}\n`);
      renameSync(written, file);

      values = next;
      version = versionOf(file);
    },
  });
}

function versionOf(file: string): string | undefined {
  const stats = statSync(file, { throwIfNoEntry: false });

  return stats && `${String(stats.mtimeMs)}:${String(stats.size)}`;
}

function parsed(file: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("it must hold an object with a key per plugin");
  }

  return value as Record<string, unknown>;
}
